import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync, lstatSync, realpathSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { clearTimeout as clearTimer, setTimeout as setTimer } from 'node:timers'
import type { GuiAcceptanceResult, GuiAcceptanceSuite } from '../desktop/gui-acceptance';
import type { LaunchDeclaration } from '../desktop/launch-smoke';
import { openDebugSession, actDebugSession, closeDebugSessions } from './debug-sessions';
import { debugWorkspace } from './debug-workspace';
import { frozenNativeGuiEntry, nativeGuiObservations } from './native-gui-tests';
import { prepareNativeTestRuntime } from './native-test-runtime';
import { prepareAcceptanceEnvironment, type AcceptanceEnvironment } from './acceptance-environment'
import type { Page } from 'playwright'

async function trackAudioEvents(page: Page) {
    await page.evaluate(() => {
        const events: Array<{event:string; index:number; current_time:number; duration:number|null}> = []
        const key = Symbol.for('bloma.hostAudioEvents')
        const players = new Set<HTMLAudioElement>()
        Object.defineProperty(window, key, { value: () => ({
            events:events.map(event => ({...event})),
            active:[...players].some(audio => !audio.loop && Number.isFinite(audio.duration) &&
                !audio.paused && !audio.ended && !audio.error),
        }) })
        const attached = new WeakSet<HTMLAudioElement>()
        document.addEventListener('playing', event => {
            const audio = event.target
            if (!event.isTrusted || !(audio instanceof HTMLAudioElement)) return
            if (!audio.loop && Number.isFinite(audio.duration)) players.add(audio)
            const index = Array.from(document.querySelectorAll('audio')).indexOf(audio)
            const record = (observed: Event) => {
                if (!observed.isTrusted) return
                if (events.length === 18) events.shift()
                events.push({event:observed.type,index,
                    current_time:audio.currentTime,duration:Number.isFinite(audio.duration)?audio.duration:null})
            }
            // Keep the listener on the original player, even if a later
            // conversation render detaches that player from the document.
            record(event)
            if (attached.has(audio)) return
            attached.add(audio)
            for (const kind of ['pause', 'ended', 'error']) audio.addEventListener(kind, observed => {
                record(observed)
                players.delete(audio)
            })
        },true)
    }).catch(() => {})
}

async function incompletePlaybackObservation(page: Page | undefined): Promise<GuiAcceptanceResult['interrupted_audio']> {
    if (!page || page.isClosed()) return
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
        return await Promise.race([
            page.evaluate(() => {
                const tracks = Array.from(document.querySelectorAll('audio')).slice(0, 8).map((audio,index) => ({
                    index, source_present: Boolean(audio.currentSrc || audio.getAttribute('src')),
                    duration: Number.isFinite(audio.duration) ? audio.duration : null, current_time: audio.currentTime,
                    paused: audio.paused, ended: audio.ended, played_ranges: audio.played.length, error: audio.error?.code ?? null,
                }))
                const read = Reflect.get(window,Symbol.for('bloma.hostAudioEvents'))
                return {tracks,events:typeof read === 'function' ? read().events : []}
            }),
            new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(Error('GUI_MEDIA_OBSERVATION_TIMEOUT')), 2000) }),
        ])
    } catch { return undefined }
    finally { clearTimeout(timer) }
}

/** Test success can be reported before the last reply finishes playing. Give
 * finite audio time to finish before success-path cleanup closes the app. */
export async function settleNativePlayback(page:Page,signal:AbortSignal):Promise<boolean> {
    if (page.isClosed() || signal.aborted) return true
    let quietSince = 0
    let timer:ReturnType<typeof setTimer>|undefined
    const started = Date.now(), limit = started + 30000
    try {
        while (Date.now() < limit && !signal.aborted && !page.isClosed()) {
            const sample = await Promise.race([
                page.evaluate(() => {
                    const players = Array.from(document.querySelectorAll('audio')).filter(audio => !audio.loop)
                    const read = Reflect.get(window,Symbol.for('bloma.hostAudioEvents'))
                    const observed = typeof read === 'function' ? read() : undefined
                    return { present:players.length > 0 || Boolean(observed?.active),
                        active:Boolean(observed?.active) || players.some(audio =>
                            Number.isFinite(audio.duration) && !audio.paused && !audio.ended && !audio.error) }
                }),
                new Promise<undefined>(resolve => { timer=setTimer(() => resolve(undefined),1000) }),
            ])
            clearTimer(timer)
            if (!sample) return false
            if (!sample.present) return true
            const now = Date.now()
            quietSince = sample.active ? 0 : quietSince || now
            if (quietSince && now - quietSince >= 1000) return true
            await new Promise(resolve => setTimeout(resolve,150))
        }
        return signal.aborted || page.isClosed()
    } catch { return page.isClosed() || signal.aborted }
    finally { clearTimer(timer) }
}

export async function runNativeGuiTests(input: {
    projectId: string;
    root: string;
    launch: LaunchDeclaration;
    suite: GuiAcceptanceSuite;
    signal?: AbortSignal;
}) {
    const native = input.suite.native_tests!;
    const sessionId = `host-native-${randomUUID()}`, signal = input.signal ?? new AbortController().signal;
    const workspace=debugWorkspace(input.projectId,sessionId)
    const runtime = prepareNativeTestRuntime(input.projectId, native, input.root, workspace), file = runtime.file
    const reports: Array<{
        code: number;
        events: string;
        trace: string;
    }> = [];
    const runtimeFailures:string[]=[]
    let interrupted:string|undefined
    let interruptedMedia: Awaited<ReturnType<typeof incompletePlaybackObservation>>
    const evidenceWarnings: string[] = []
    let environment: AcceptanceEnvironment | undefined
    try {
        const prepared = await prepareAcceptanceEnvironment({ root: input.root, features: input.suite.covers,
            requiresLlm: false, supportsControlledOutput: true, useDeclaredSettingsOnly: true, signal })
        environment = prepared
        for (const phase of native.restart ? ['initial', 'reopened'] : ['initial']) {
            signal.throwIfAborted();
            runtime.verify();
            let observedPage: Page | undefined
            const opened = await openDebugSession({ projectId: input.projectId, sessionId, root: input.root, launch: input.launch, signal, formal:true,
                preparePage: async page => {
                    observedPage = page
                    await prepared.prepare(page, phase === 'initial' ? 0 : 1)
                    await trackAudioEvents(page)
                } });
            const directory = debugWorkspace(input.projectId, sessionId), report = join(directory, `native-${phase}.jsonl`), trace = join(directory, `native-${phase}-trace.json`);
            let observed:Awaited<ReturnType<typeof actDebugSession>>|undefined
            try{observed=await actDebugSession({ projectId: input.projectId, sessionId, id: opened.id, signal, nativeTests: { file, phase, report, trace } })}
            catch(error){signal.throwIfAborted();interrupted=String(error);interruptedMedia=await incompletePlaybackObservation(observedPage)}
            runtime.verify();
            if (observed?.screenshot_error) evidenceWarnings.push(observed.screenshot_error)
            const outcome = observed?.steps.find(step => step.id === 'native-tests')?.actual as {
                exit_code?: number;
                stderr?: string;
            } | undefined;
            if (!existsSync(report) || !existsSync(trace) || statSync(report).size > 2 * 1024 * 1024 || statSync(trace).size > 16384)
                throw Error(`GUI_NATIVE_REPORT_MISSING: ${interrupted??outcome?.stderr ?? ''}\n${existsSync(report) ? readFileSync(report, 'utf8').slice(-8000) : 'Node reporter did not produce output'}`);
            const runtimeErrors = observed?.observations.filter(row => row.version === observed!.version && /^renderer\.(?:error|startup_error)$/.test(row.kind))??[];
            runtimeFailures.push(...runtimeErrors.map(row=>row.message))
            reports.push({ code: runtimeErrors.length ? 1 : outcome?.exit_code ?? 1, events: readFileSync(report, 'utf8'), trace: readFileSync(trace, 'utf8') });
            if (outcome?.exit_code === 0 && !runtimeErrors.length && observedPage &&
                !await settleNativePlayback(observedPage,signal)) evidenceWarnings.push('测试窗口关闭前未能确认最后一段有限音频已自然结束。')
            await closeDebugSessions(input.projectId, sessionId);
            if (outcome?.exit_code !== 0 || runtimeErrors.length)
                break;
        }
        frozenNativeGuiEntry(input.projectId, native, input.root);
        const result={...nativeGuiObservations(input.suite,reports),environment:prepared.evidence()}
        const evidence_dir = join(workspace, 'evidence', 'acceptance')
        if(interrupted)return{...result,evidence_dir,evidence_warnings:evidenceWarnings,status:result.status==='failed'?'failed' as const:'unverified' as const,failure_kind:result.status==='failed'?result.failure_kind:'incomplete' as const,
          error:'GUI_NATIVE_EXECUTION_INCOMPLETE: '+interrupted,
          ...(interruptedMedia&&(interruptedMedia.tracks.length||interruptedMedia.events.length)?{interrupted_audio:interruptedMedia}:{})}
        return runtimeFailures.length?{...result,evidence_dir,evidence_warnings:evidenceWarnings,status:'failed' as const,failure_kind:'runtime' as const,
          case_results:result.case_results.map(row=>row.status==='passed'?{...row,status:'unverified' as const}:row),error:`GUI_NATIVE_RUNTIME_ERROR: ${runtimeFailures[0]}`,
          steps:[...result.steps,{id:'native-runtime',passed:false,actual:runtimeFailures.slice(0,3)}]}:{...result,evidence_dir,evidence_warnings:evidenceWarnings}
    }
    finally {
        try { await closeDebugSessions(input.projectId, sessionId) }
        finally { await environment?.close() }
        runtime.close();
        // Reports and synthetic data remain inspectable; don't retain a large
        // Chromium profile for every finished formal test run. These are owned
        // isolated test directories, never a user's daily browser profile.
        for(const name of ['formal-profile','profile','environment-home','data/electron-profile']){
          const target=join(workspace,name)
          if(!existsSync(target))continue
          if(lstatSync(target).isSymbolicLink()||relative(realpathSync(workspace),realpathSync(target)).replaceAll('\\','/')!==name)throw Error('GUI_NATIVE_CLEANUP_PATH_INVALID')
          try{rmSync(target,{recursive:true,force:true,maxRetries:3,retryDelay:100})}catch{console.warn('Native test profile cleanup deferred; isolated diagnostic workspace retained')}
        }
    }
}

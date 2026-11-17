/** Product-owned provenance on the existing transactional store. No platform memory. */
function createProvenance({store}) {
  const type='provenance'
  function row(snapshot,id) { const r=snapshot.records[id]; if(!r||r.type!==type)throw Error('PROVENANCE_MISSING');return r }
  function descendants(snapshot,id) {
    const affected=new Set([id]);let changed=true
    while(changed){changed=false;for(const r of Object.values(snapshot.records))if(r.type===type&&!affected.has(r.id)&&r.refs.some(ref=>affected.has(ref))){affected.add(r.id);changed=true}}
    affected.delete(id);return [...affected]
  }
  function source({id,expectedRevision,payload}) {
    const snapshot=store.read(),old=snapshot.records[id]
    if(old&&(old.type!==type||old.data.kind!=='source'))throw Error('PROVENANCE_KIND_CHANGED')
    const changes=[{id,type,expectedRevision,data:{kind:'source',payload,status:'current'},refs:[]}]
    if(old)for(const derived of descendants(snapshot,id)){const r=row(snapshot,derived);changes.push({id:r.id,expectedRevision:r.revision,data:{...r.data,status:'stale',invalidatedBy:id},refs:r.refs})}
    return store.commit(snapshot.revision,changes).records[id]
  }
  function capture(ids) {
    if(!Array.isArray(ids)||!ids.length||ids.length>64||new Set(ids).size!==ids.length)throw Error('PROVENANCE_REFS_INVALID')
    const snapshot=store.read();return ids.map(id=>{const r=row(snapshot,id);if(r.data.status!=='current')throw Error('PROVENANCE_SOURCE_STALE');return{id,revision:r.revision}})
  }
  function publish({id,expectedRevision,kind,payload,sources,signal}) {
    signal?.throwIfAborted()
    if(!['inference','creative'].includes(kind)||!Array.isArray(sources)||!sources.length||sources.length>64||new Set(sources.map(s=>s?.id)).size!==sources.length)throw Error('PROVENANCE_RESULT_INVALID')
    const snapshot=store.read(),old=snapshot.records[id]
    if(old&&(old.type!==type||old.data.kind==='source'))throw Error('PROVENANCE_KIND_CHANGED')
    const downstream=new Set(old?descendants(snapshot,id):[])
    for(const ref of sources){if(!ref||ref.id===id||downstream.has(ref.id))throw Error('PROVENANCE_CYCLE');const r=row(snapshot,ref.id);if(r.revision!==ref.revision||r.data.status!=='current')throw Error('PROVENANCE_SOURCE_STALE')}
    const changes=[{id,type,expectedRevision,data:{kind,payload,status:'current',sources},refs:sources.map(s=>s.id)}]
    for(const child of downstream){const r=row(snapshot,child);changes.push({id:child,expectedRevision:r.revision,data:{...r.data,status:'stale',invalidatedBy:id},refs:r.refs})}
    signal?.throwIfAborted();return store.commit(snapshot.revision,changes).records[id]
  }
  function remove({id,expectedRevision,cascade=false}) {
    const snapshot=store.read(),r=row(snapshot,id)
    if(r.revision!==expectedRevision)throw Error('PROVENANCE_REVISION_STALE')
    const dependents=descendants(snapshot,id)
    if(dependents.length&&!cascade)throw Error('PROVENANCE_DEPENDENTS_REQUIRE_DECISION')
    return store.commit(snapshot.revision,[id,...dependents].map(key=>({id:key,expectedRevision:row(snapshot,key).revision,delete:true})))
  }
  function current(){return Object.values(store.read().records).filter(r=>r.type===type&&r.data.status==='current')}
  return {source,capture,publish,remove,current,read:()=>store.read()}
}
module.exports={createProvenance}

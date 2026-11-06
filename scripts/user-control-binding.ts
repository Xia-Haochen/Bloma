/** Runs in the page. Identity comes only from the observed DOM, never model selectors.
 * No positional fallback: a replaced/reordered row must still have a unique identity. */
export function bindUserControl(node:Node){
  const element=node as Element
  const attributes=(e:Element)=>[...e.attributes].filter(a=>a.value&&a.value.length<=1024
    &&(['id','name','type','aria-label','aria-labelledby','href','for'].includes(a.name)||a.name.startsWith('data-')))
    .map(a=>`[${CSS.escape(a.name)}="${CSS.escape(a.value)}"]`).join('')
  const own=(e:Element)=>{const attrs=attributes(e);if(!attrs||![...e.attributes].some(a=>a.value&&a.name!=='type'&&(['id','name','aria-label','aria-labelledby','href','for'].includes(a.name)||a.name.startsWith('data-'))))return;const selector=e.tagName.toLowerCase()+attrs;return document.querySelectorAll(selector).length===1?selector:undefined}
  const locate=(e:Element)=>{
    const row=e.closest('tr,[role="row"],li,[role="listitem"]'),rowAnchor=row&&row!==e?own(row):undefined
    if(rowAnchor){const scoped=rowAnchor+' '+e.tagName.toLowerCase()+attributes(e);if(document.querySelectorAll(scoped).length===1)return scoped}
    const direct=own(e);if(direct)return direct
    for(let parent=e.parentElement;parent&&parent!==document.body;parent=parent.parentElement){
      const anchor=own(parent);if(!anchor)continue
      const selector=anchor+' '+e.tagName.toLowerCase()+attributes(e)
      if(document.querySelectorAll(selector).length===1)return selector
    }
  }
  const selector=locate(element)
  const label=element instanceof HTMLInputElement&&['radio','checkbox','file'].includes(element.type)
    ?[...element.labels??[]].find(l=>!!(l.offsetWidth||l.offsetHeight||l.getClientRects().length)):undefined
  return{selector,clickSelector:label?locate(label):selector}
}

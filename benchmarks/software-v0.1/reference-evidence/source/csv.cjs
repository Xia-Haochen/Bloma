function parse(text) {
  text=text.replace(/^\uFEFF/,'')
  const rows=[]
  let row=[],value='',quoted=false
  for(let i=0;i<text.length;i++){
    const ch=text[i]
    if(ch==='"'){
      if(quoted&&text[i+1]==='"'){value+='"';i++}else quoted=!quoted
    }else if(ch===','&&!quoted){row.push(value);value=''}
    else if(ch==='\n'&&!quoted){row.push(value.replace(/\r$/,''));rows.push(row);row=[];value=''}
    else value+=ch
  }
  if(quoted)throw Error('CSV引号未闭合')
  if(value||row.length){row.push(value.replace(/\r$/,''));rows.push(row)}
  return rows.filter(row=>row.some(value=>value!==''))
}
function stringify(rows){return rows.map(row=>row.map(value=>'"'+String(value).replaceAll('"','""')+'"').join(',')).join('\r\n')+'\r\n'}
module.exports={parse,stringify}

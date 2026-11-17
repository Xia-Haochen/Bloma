const {parse,stringify}=require('./csv.cjs')
const initial=()=>({equipment:[],members:[],loans:[]})
function outstanding(state,equipment,member){
  return state.loans.filter(row=>row.equipment===equipment&&(!member||row.member===member)).reduce((sum,row)=>sum+row.quantity-row.returned,0)
}
function summary(state,date='2026-11-16'){
  return {equipment:state.equipment.map(row=>({...row,outstanding:outstanding(state,row.id),available:row.total-outstanding(state,row.id)})),
    members:state.members,loans:state.loans,overdue:state.loans.filter(row=>row.due<date&&row.quantity>row.returned)}
}
function importRows(state,files){
  const next=structuredClone(state)
  for(const file of files){
    const rows=parse(Buffer.from(file.data,'base64').toString('utf8')),header=rows.shift()
    if(header?.join(',')==='kind,data'){
      const restored=initial()
      for(const [kind,data]of rows){if(!Object.hasOwn(restored,kind))throw Error('备份类型错误');restored[kind].push(JSON.parse(data))}
      Object.assign(next,restored)
    }else if(header?.join(',')==='id,name,total'){
      for(const [id,name,value]of rows){
        if(!id||!name||next.equipment.some(row=>row.id===id))throw Error('重复或缺少器材编号 '+id)
        const total=Number(value)
        if(!Number.isInteger(total)||total<0)throw Error('错误数量 '+id)
        next.equipment.push({id,name,total})
      }
    }else if(header?.join(',')==='id,name'){
      for(const [id,name]of rows){
        if(!id||!name||next.members.some(row=>row.id===id))throw Error('重复或缺少成员编号 '+id)
        next.members.push({id,name})
      }
    }else throw Error('CSV列定义错误 '+file.name)
  }
  return next
}
function execute(state,action,input){
  const next=structuredClone(state)
  if(action==='add-equipment'){
    if(next.equipment.some(row=>row.id===input.equipment))throw Error('重复器材编号 '+input.equipment)
    if(!input.equipment||!input.name?.trim()||!Number.isInteger(Number(input.quantity))||Number(input.quantity)<0)throw Error('器材信息错误')
    next.equipment.push({id:input.equipment,name:input.name.trim(),total:Number(input.quantity)})
  }else if(action==='add-member'||action==='rename-member'){
    const member=next.members.find(row=>row.id===input.member)
    if(!input.member||!input.name?.trim())throw Error('成员信息错误')
    if(action==='add-member'){if(member)throw Error('重复成员编号');next.members.push({id:input.member,name:input.name.trim()})}
    else{if(!member)throw Error('成员不存在');member.name=input.name.trim()}
  }else if(action==='rename'){
    const row=next.equipment.find(row=>row.id===input.equipment)
    if(!row||!input.name.trim())throw Error('器材或名称无效')
    row.name=input.name.trim()
  }else if(action==='borrow'||action==='return'){
    const item=next.equipment.find(row=>row.id===input.equipment)
    if(!item||!next.members.some(row=>row.id===input.member))throw Error('器材或成员不存在')
    const quantity=Number(input.quantity)
    if(!Number.isInteger(quantity)||quantity<=0)throw Error('数量必须为正整数')
    if(action==='borrow'){
      if(item.total-outstanding(next,item.id)<quantity)throw Error('库存不足')
      if(!/^\d{4}-\d{2}-\d{2}$/.test(input.due))throw Error('应还日期错误')
      next.loans.push({id:'L'+(next.loans.length+1),equipment:item.id,member:input.member,quantity,returned:0,due:input.due})
    }else{
      if(outstanding(next,item.id,input.member)<quantity)throw Error('归还超过未还量')
      let remaining=quantity
      for(const row of next.loans.filter(row=>row.equipment===item.id&&row.member===input.member)){
        const count=Math.min(remaining,row.quantity-row.returned)
        row.returned+=count;remaining-=count
      }
    }
  }else throw Error('未知操作')
  return next
}
function backup(state){
  return stringify([['kind','data'],...Object.entries(state).flatMap(([kind,rows])=>rows.map(row=>[kind,JSON.stringify(row)]))])
}
module.exports={initial,summary,importRows,execute,backup}

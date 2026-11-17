import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { createProfilePresets } from '../src/hub/discussions/presets.ts'
import { runInNewContext } from 'node:vm'
import { PRESETS_SCRIPT } from '../src/hub/discussions/presets-page.ts'

const cleanup: string[] = []
afterEach(() => { for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true }) })
function setup() {
  const dir=mkdtempSync(join(tmpdir(),'marshal-presets-'));cleanup.push(dir)
  const file=join(dir,'presets.json'),store=createProfilePresets(file,'owner',()=>1000)
  return {file,store}
}
const profile={persona:'Calm engineer',expertise:'expert',stance:'review'}
describe('account workspace profile presets', () => {
  it('preserves a draft member when a remote preset changes and clearly marks it custom until reselected', () => {
    const selectors: any[]=[]
    const element=()=>({value:'',disabled:false,children:[] as any[],append(...nodes:any[]){this.children.push(...nodes)},setAttribute(name:string){if(name==='data-group-preset')selectors.push(this)}})
    const nodes=new Map<string,any>()
    const ui=runInNewContext(PRESETS_SCRIPT+';({updateGroupPresets,groupPresetControls})',{
      document:{createElement:element,querySelectorAll:()=>selectors},textNode:element,
      clearNode:(node:any)=>{node.children=[]},groupNode:(id:string)=>{if(!nodes.has(id))nodes.set(id,element());return nodes.get(id)},groupProfileSummary:()=>'',
    })
    const preset={id:randomUUID(),name:'Reviewer',profile},member={...profile}
    ui.updateGroupPresets({revision:0,items:[preset]})
    const controls=ui.groupPresetControls(member,'member',()=>{})
    expect(controls.select.value).toBe(preset.id)
    ui.updateGroupPresets({revision:1,items:[{...preset,profile:{...profile,persona:'Remote edit'}}]})
    expect(member.persona).toBe(profile.persona)
    expect(controls.select.value).toBe('')
    controls.select.value=preset.id;controls.select.onchange()
    expect(member.persona).toBe('Remote edit')
    ui.updateGroupPresets({revision:2,items:[]})
    expect(member.persona).toBe('Remote edit');expect(controls.select.value).toBe('')
  })
  it('persists reusable profiles and does not recreate deleted defaults on restart', () => {
    const {file,store}=setup();expect(store.list().items).toHaveLength(3)
    const id=randomUUID(),saved=store.mutate({action:'save',id,key:'create',revision:0,name:' Backend reviewer ',profile})
    expect(saved.items.find(p=>p.id===id)).toMatchObject({name:'Backend reviewer',profile})
    saved.items[0]!.profile.persona='client mutation'
    expect(store.list().items[0]!.profile.persona).not.toBe('client mutation')
    let current=createProfilePresets(file,'owner').list();expect(current.revision).toBe(1)
    for(const item of current.items)current=store.mutate({action:'delete',id:item.id,key:item.id,revision:current.revision})
    expect(createProfilePresets(file,'owner').list()).toEqual({revision:5,items:[]})
  })
  it('rejects a stale device edit or deletion, retries the last write safely and blocks resurrection', () => {
    const {store}=setup(),id=randomUUID(),input={action:'save',id,key:'create',revision:0,name:'reviewer',profile}
    const saved=store.mutate(input)
    expect(store.mutate(input)).toEqual(saved)
    expect(()=>store.mutate({...input,name:'changed'})).toThrow('idempotency-conflict')
    const update={...input,key:'device-b',revision:1,name:'reviewer B'}
    store.mutate(update)
    expect(()=>store.mutate({...update,key:'device-a',name:'stale A'})).toThrow('revision-conflict')
    expect(()=>store.mutate({action:'delete',id,key:'stale-delete',revision:1})).toThrow('revision-conflict')
    const removed=store.mutate({action:'delete',id,key:'delete',revision:2})
    expect(store.mutate({action:'delete',id,key:'delete',revision:2})).toEqual(removed)
    expect(()=>store.mutate(input)).toThrow('revision-conflict')
  })
  it('validates names, profiles, capacity and store ownership without changing the library', () => {
    const {store,file}=setup(),id=randomUUID(),input={action:'save',id,key:'new',revision:0,name:'NEW',profile}
    expect(()=>store.mutate({...input,name:'   '})).toThrow()
    expect(()=>store.mutate({...input,profile:{...profile,stance:'execute-with-root'}})).toThrow()
    expect(()=>store.mutate({...input,profile:{...profile,persona:'x'.repeat(601)}})).toThrow()
    expect(()=>createProfilePresets(file,'different-owner')).toThrow('recovery-required')
    store.mutate(input)
    expect(()=>store.mutate({...input,id:randomUUID(),key:'duplicate',revision:1,name:' new '})).toThrow('preset-name-conflict')
    let current=store.list()
    while(current.items.length<64)current=store.mutate({...input,id:randomUUID(),key:randomUUID(),revision:current.revision,name:'preset '+current.items.length})
    expect(()=>store.mutate({...input,id:randomUUID(),key:'limit',revision:current.revision,name:'one more'})).toThrow('size-limit')
    expect(store.list()).toEqual(current)
  })
  it('keeps disk corruption visible and does not publish failed persistence to memory', () => {
    const {store,file}=setup(),before=store.list(),disk=readFileSync(file,'utf8')
    renameSync(file,file+'.backup');mkdirSync(file)
    expect(()=>store.mutate({action:'save',id:randomUUID(),key:'fail',revision:0,name:'fail',profile})).toThrow('recovery-required')
    expect(store.list()).toEqual(before)
    rmSync(file,{recursive:true});writeFileSync(file,'{broken')
    expect(()=>createProfilePresets(file,'owner')).toThrow()
    expect(readFileSync(file,'utf8')).toBe('{broken')
    expect(JSON.parse(disk).operatorId).toBe('owner')
  })
})

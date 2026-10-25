import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertPackageFiles } from './package-contract.mjs'
import { npmExecFileSync } from './process.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
assert(process.argv.length === 3 && process.argv[2], 'Pass one exact prebuilt .tgz path; no build or live profile install is performed')
const archive = resolve(root, process.argv[2]), info = await stat(archive)
assert(info.isFile() && extname(archive) === '.tgz' && info.size > 0 && info.size <= 128 * 1024 * 1024, 'Expected a bounded regular .tgz archive')
const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).split(/\r?\n/).map(line => line.trim()).filter(Boolean)
assert(entries.length <= 1024 && entries.every(path => /^package\/[A-Za-z0-9@._/-]+$/.test(path) && path.split('/').every(part => part !== '.' && part !== '..' && part !== '')), 'Unsafe or excessive archive entries')
const verbose = execFileSync('tar', ['-tvzf', archive], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).split(/\r?\n/).map(line => line.trim()).filter(Boolean)
assert(verbose.length === entries.length && verbose.every((line, index) => line.startsWith('-') && line.endsWith(` ${entries[index]}`)), 'Archive links, directories, devices and ambiguous entries are forbidden')
const archived = JSON.parse(execFileSync('tar', ['-xOf', archive, 'package/package.json'], { encoding: 'utf8' }))
assertPackageFiles(archived, entries.map(path => path.slice('package/'.length)))
for (const name of ['preinstall', 'install', 'postinstall', 'prepare']) assert(!archived.scripts?.[name], `Prebuilt package must not require install-time ${name}`)
const source = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
assert.equal(archived.name, source.name); assert.equal(archived.version, source.version, 'Archive must match the selected source release')
const version = process.env.DSH_INSTALL_VERSION || '0.2.0-rc.2'
assert(archived.engines.dsh.split('||').map(value => value.trim()).includes(version), 'Production install must name a declared exact DSH release')
const dependencies = Object.fromEntries(Object.keys(archived.peerDependencies).filter(name => name.startsWith('@deepseek-ai/dsh-')).map(name => [name, version]))
// Actual isolated-host test prerequisites, not new production plugin dependencies.
for (const name of ['dsh-api-gateway', 'dsh-typert-registry']) dependencies[`@deepseek-ai/${name}`] = version
if (['0.2.1-alpha.3', '0.2.1-alpha.4', '0.2.1-rc.1', '0.2.1-rc.2', '0.2.1-rc.3'].includes(version)) dependencies['@deepseek-ai/dsh-api-remote-access'] = version
const target = await mkdtemp(join(tmpdir(), 'session-dashboard-install-'))
await writeFile(join(target, 'package.json'), JSON.stringify({ name: 'isolated-session-dashboard-consumer', version: '1.0.0', private: true, type: 'module', dependencies }))
npmExecFileSync(['install', '--omit=dev', '--ignore-scripts', '--prefer-offline', '--no-audit', '--no-fund', archive], { cwd: target, stdio: 'inherit', env: { ...process.env, NODE_PATH: '', INIT_CWD: target } })
await writeFile(join(target, 'package-contract.mjs'), await readFile(new URL('./package-contract.mjs', import.meta.url), 'utf8'))
const smoke = `
import assert from 'node:assert/strict'
import {readFile,stat,mkdtemp} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {dirname,join,sep} from 'node:path'
import {fileURLToPath} from 'node:url'
import {Context} from '@deepseek-ai/cordis'
import {HostConnectionService} from '@deepseek-ai/dsh-client-connection'
import Registry from '@deepseek-ai/dsh-typert-registry'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import {readPluginMeta} from '@deepseek-ai/dsh-app-boot'
import * as host from '@hsx/dsh-session-dashboard'
import {TYPERT} from '@hsx/dsh-session-dashboard/typert'
import remote from '@hsx/dsh-session-dashboard/remote'
import * as api from '@hsx/dsh-session-dashboard/api'
import * as slots from '@hsx/dsh-session-dashboard/slots'
import {API_VERSION,assertLocalizedMetadata,assertPublicContract} from './package-contract.mjs'
const manifestPath=fileURLToPath(import.meta.resolve('@hsx/dsh-session-dashboard/package.json')),directory=dirname(manifestPath)
const manifest=JSON.parse(await readFile(manifestPath,'utf8'))
assert.equal(host.name,'session-dashboard');assert.equal(typeof host.apply,'function')
assert.equal(manifest.version,${JSON.stringify(archived.version)})
assertPublicContract(manifest,TYPERT,remote,api,slots)
for(const name of ['src','test','build.mjs','tsconfig.json','docs/TECH-DESIGN.md','package-lock.json','node_modules/typescript']) await assert.rejects(stat(join(directory,name)))
await assert.rejects(stat(join(process.cwd(),'node_modules/typescript')))
for(const name of ['README.md','README.en.md',manifest.main,manifest.types,manifest.dsh.bundle.patch])assert((await stat(join(directory,name))).isFile())
const locales=Object.fromEntries(await Promise.all(['en','zh'].map(async language=>[language,JSON.parse(await readFile(new URL(import.meta.resolve('@hsx/dsh-session-dashboard/locale/'+language+'.json')),'utf8'))])))
assertLocalizedMetadata(readPluginMeta(manifest.name,import.meta.url),locales)
for(const [name,version]of Object.entries(${JSON.stringify(dependencies)})){
 const entry=fileURLToPath(import.meta.resolve(name)),marker=sep+'node_modules'+sep+name.split('/').join(sep)+sep,index=entry.lastIndexOf(marker)
 assert(index>=0,'SDK must resolve inside this installed consumer: '+name)
 const value=JSON.parse(await readFile(join(entry.slice(0,index+marker.length),'package.json'),'utf8'));assert.equal(value.name,name);assert.equal(value.version,version)
}
// The smoke owns every resource it creates. Never read a live session or database.
const profile=await mkdtemp(join(tmpdir(),'dashboard-installed-core-startup-')),ctx=new Context(),fibers=[]
const mount=async(plugin,config)=>{const fiber=ctx.plugin(plugin,config);fibers.push(fiber);await fiber.await();assert.equal(fiber.error,undefined)}
ctx.reflect.provide('profileContext',{dir:profile,name:'isolated-core-install'})
ctx.reflect.provide('sessions',{get:()=>undefined,list:()=>[],async flush(){return true}})
ctx.reflect.provide('agents',{get:()=>undefined,list:()=>[],roots:()=>[]})
ctx.reflect.provide('sessionQuery',{async listSessions(){return []}})
ctx.reflect.provide('sessionPersistence',{async list(){return []},async stat(){return undefined}})
try{
 let connection
 await mount(scope=>{connection=new HostConnectionService(scope,[],{isAuthenticated:request=>new Headers(request.headers).get('x-fixture-browser')==='authenticated'})})
 await mount(Registry)
 if(${JSON.stringify(Boolean(dependencies['@deepseek-ai/dsh-api-remote-access']))}){const access=await import('@deepseek-ai/dsh-api-remote-access');await mount(access.default,{})}
 await mount(Gateway,{})
 await mount(host)
 const carrier=connection.createSharedFetchHandler('/api')
 const wire=async(method,args={})=>{
  const endpoint='sessionDashboard/'+method,rpcId='isolated-core-install-rpc',admission=connection.admit({headers:new Headers({host:'localhost','x-fixture-browser':'authenticated'})});assert(admission.peer)
  const response=await carrier.fetch(new Request('http://localhost/api/'+endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId,method:endpoint,payload:{args}})}),admission.peer)
  assert.equal(response.status,200);const envelope=await response.json();assert.equal(envelope.rpcId,rpcId);assert.equal(envelope.result.ok,true,JSON.stringify(envelope.result));return envelope.result.value
 }
 const handshake=await wire('handshake');assert.equal(handshake.apiVersion,API_VERSION)
 assert.equal((await wire('snapshot')).board.cards.length,0)
 const changed=await wire('mutate',{mutation:{apiVersion:API_VERSION,serviceId:handshake.serviceId,requestId:'88a2377a-a035-4ee1-8855-ab027e01a3f6',command:{type:'create_project',name:'Installed RPC project',color:null,tagIds:[]}}})
 assert.equal(changed.board.projects[0].name,'Installed RPC project')
 assert((await stat(join(profile,'data/session-dashboard/dashboard.sqlite'))).isFile())
}finally{for(const fiber of fibers.toReversed())await fiber.dispose();assert.equal(ctx.get('sessionDashboard'),undefined)}
console.log('Prebuilt API2, ten strict RPC contracts, zh/en host metadata, default startup and authenticated carrier read/write passed in isolation.')
`
await writeFile(join(target, 'smoke.mjs'), smoke)
execFileSync(process.execPath, ['smoke.mjs'], { cwd: target, stdio: 'inherit', env: { ...process.env, NODE_PATH: '' } })
const result = { package: archived.name, version: archived.version, archive, sha256: createHash('sha256').update(await readFile(archive)).digest('hex'), dshVersion: version, isolatedConsumer: target, productionOnly: true, installScriptsDisabled: true, apiVersion: 2, authenticatedCarrierRpc: true, localizedMetadata: ['zh', 'en'], liveProfileModified: false }
await mkdir(join(root, 'artifacts'), { recursive: true })
await writeFile(join(root, 'artifacts', 'install-verification.json'), `${JSON.stringify(result, null, 2)}\n`)
console.log(JSON.stringify(result, null, 2))
// Preserve the verified consumer for inspection; never delete inferred user paths.

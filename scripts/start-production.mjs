/**
 * Start de produção (EasyPanel / Docker):
 * - Garante dist/ (vite build) antes de subir o Express
 * - Sobe server.js com HOST=0.0.0.0 (obrigatório em container)
 */
import { existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { spawn } from 'child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const distIndex = join(root, 'dist', 'index.html')

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: root,
      stdio: 'inherit',
      env: process.env,
      shell: process.platform === 'win32',
    })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${cmd} ${args.join(' ')} exit ${code}`))
    })
  })
}

if (!existsSync(distIndex)) {
  console.log('[start] dist/index.html ausente — executando npm run build…')
  await run('npm', ['run', 'build'])
  if (!existsSync(distIndex)) {
    console.error('[start] Build falhou: dist/index.html não foi gerado.')
    process.exit(1)
  }
}

process.env.HOST = process.env.HOST || '0.0.0.0'
process.env.PORT = process.env.PORT || '8000'
console.log(`[start] Subindo server.js em ${process.env.HOST}:${process.env.PORT}`)

const server = spawn('node', ['server.js'], {
  cwd: root,
  stdio: 'inherit',
  env: process.env,
})

server.on('exit', (code) => process.exit(code ?? 1))

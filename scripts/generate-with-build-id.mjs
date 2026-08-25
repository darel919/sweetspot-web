import { spawn } from 'node:child_process'

const configured = process.env.NUXT_PUBLIC_BUILD_SHA
  || process.env.CF_PAGES_COMMIT_SHA
  || process.env.GITHUB_SHA
let buildSha = configured

if (!buildSha) {
  const result = await Bun.$`git rev-parse HEAD`.nothrow().quiet()
  if (result.exitCode === 0) buildSha = result.text().trim()
}

if (!buildSha) buildSha = 'local'

const child = spawn('nuxt', ['generate'], {
  env: { ...process.env, NUXT_PUBLIC_BUILD_SHA: buildSha },
  stdio: 'inherit',
})

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  process.exit(code ?? 1)
})

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

async function verifyGeneratedBuildId() {
  if (buildSha === 'local') throw new Error('A generated production build requires a non-local build SHA.')
  const output = Bun.file('.output/public/index.html')
  if (!(await output.exists())) throw new Error('Nuxt generation did not produce .output/public.')
  const glob = new Bun.Glob('**/*')
  for await (const relativePath of glob.scan('.output/public')) {
    const file = Bun.file(`.output/public/${relativePath}`)
    if (file.size > 5_000_000) continue
    if ((await file.text()).includes(buildSha)) return
  }
  throw new Error(`Generated assets do not contain build SHA ${buildSha}.`)
}

child.on('exit', async (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  if ((code ?? 1) !== 0) process.exit(code ?? 1)
  try {
    await verifyGeneratedBuildId()
    process.exit(0)
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  }
})

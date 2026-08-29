const fs = require('fs')
const path = require('path')

exports.default = async function(context) {
  const appDir = context.appOutDir
  const resourceDir = path.join(appDir, 'resources', 'app')
  const targetModules = path.join(resourceDir, 'node_modules')
  const sourceModules = path.join(context.packager.info.projectDir, 'node_modules')

  console.log(`[afterPack] Copying full node_modules from ${sourceModules} to ${targetModules}`)

  if (fs.existsSync(targetModules)) {
    fs.rmSync(targetModules, { recursive: true, force: true })
  }

  copyDirSync(sourceModules, targetModules)

  console.log(`[afterPack] node_modules copied: ${fs.readdirSync(targetModules).length} entries`)
}

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true })
  const entries = fs.readdirSync(src, { withFileTypes: true })
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name)
    const destPath = path.join(dest, entry.name)
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath)
    } else {
      fs.copyFileSync(srcPath, destPath)
    }
  }
}

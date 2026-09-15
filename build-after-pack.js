const fs = require('fs')
const path = require('path')

exports.default = async function(context) {
  const appDir = context.appOutDir
  // A-13：运行时 NODE_PATH 指向 join(process.resourcesPath,'node_modules')
  // 即 resources/node_modules；原复制到 resources/app/node_modules 差一层目录，
  // 打包版 node -e 受信模板 require('docx') 等必然 Cannot find module
  const resourceDir = path.join(appDir, 'resources')
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

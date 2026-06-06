const fs = require('bare-fs')

require.asset = require('require-asset')

const bareclaw = require.asset('#bareclaw', __filename)

try {
  fs.accessSync(bareclaw, fs.constants.X_OK)
} catch {
  fs.chmodSync(bareclaw, 0o755)
}

module.exports = bareclaw

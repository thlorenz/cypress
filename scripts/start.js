const path = require('path')

process.env.PROJECT_BASE_DIR = path.join(__dirname, '..')
require('@packages/server')

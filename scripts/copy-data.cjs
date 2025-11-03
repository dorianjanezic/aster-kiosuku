#!/usr/bin/env node
/* eslint-disable */
const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')

async function main() {
    const appDir = process.cwd()
    const repoRoot = path.join(appDir, '..', '..')
    const srcDir = path.join(repoRoot, 'sim_data')
    const destDir = path.join(appDir, 'public', 'data')
    try {
        await fsp.mkdir(destDir, { recursive: true })
        const files = ['pairs.json', 'cycles.jsonl', 'orders.jsonl']
        for (const file of files) {
            const from = path.join(srcDir, file)
            const to = path.join(destDir, file)
            await fsp.copyFile(from, to)
        }
        if (process.env.DEBUG) console.error('[copy-data] copied pairs.json')
    } catch (e) {
        if (process.env.DEBUG) console.error('[copy-data] skipped:', e.message)
    }
}

main()



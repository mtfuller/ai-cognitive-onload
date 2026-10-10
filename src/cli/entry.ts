import { SyseditError } from '../node/service.ts'
import { main } from './main.ts'

const command = process.argv[2]
main(process.argv.slice(2)).then(
  code => {
    // The MCP server and the editor end when their input or a signal does.
    if (command !== 'mcp' && command !== 'serve') process.exit(code)
  },
  error => {
    process.stderr.write(`${error instanceof SyseditError ? error.message : error instanceof Error ? error.stack : String(error)}\n`)
    process.exit(1)
  },
)

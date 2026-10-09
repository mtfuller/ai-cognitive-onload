export const meta = {
  name: 'map-entry-points',
  description: 'Map several entry points for System Editor in parallel, one mapper agent each, and return their model slices for save_model.',
  phases: [{ title: 'Map entry points' }],
}

// args: { request: string, entryPoints: string[], existingIds?: string[] }
const input = args ?? {}
const entryPoints = Array.isArray(input.entryPoints) ? input.entryPoints : []
if (entryPoints.length === 0) {
  log('No entry points given: pass { entryPoints: ["POST /checkout", ...], request }.')
  return []
}

const sliceSchema = {
  type: 'object',
  required: ['version', 'commit', 'nodes', 'edges', 'flows'],
  properties: {
    version: { const: 1 },
    commit: { type: 'string' },
    nodes: { type: 'array', items: { type: 'object', required: ['id', 'label', 'kind'] } },
    edges: { type: 'array', items: { type: 'object', required: ['from', 'to', 'kind', 'confidence'] } },
    flows: { type: 'array', items: { type: 'object', required: ['id', 'entry', 'entryNode', 'steps'] } },
  },
}

phase('Map entry points')
const slices = await pipeline(entryPoints, entry =>
  agent(
    [
      `Map the entry point "${entry}" for System Editor, following the sysedit:mapper agent's instructions exactly.`,
      `The engineer's request, for context only (map what exists, not what they want): ${input.request ?? '(none)'}`,
      `Reuse these node ids for the same code: ${(input.existingIds ?? []).join(', ') || '(none yet)'}.`,
      'Every non-external node needs source.file and source.lines; every edge read from code needs evidence with file and line; mark indirect links inferred with a note.',
      'Return the model slice as JSON.',
    ].join('\n'),
    { label: entry, schema: sliceSchema },
  ),
)

return slices.filter(Boolean)

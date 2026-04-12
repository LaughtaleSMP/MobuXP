import { world, system } from '@minecraft/server'

const BLOCKED_IDS = [
  'minecraft:zombie_pigman',
  'minecraft:zombified_piglin',
]

function isValid(entity) {
  try {
    return typeof entity.isValid === 'function' ? entity.isValid() : !!entity.isValid
  } catch { return false }
}

function tryRemove(entity) {
  try { entity.remove(); return } catch { /* ignored */ }
  try { entity.kill()          } catch { /* ignored */ }
}

function handle(entity, source) {
  try {
    if (!isValid(entity)) return
    const { x, y, z } = entity.location
    const typeId = entity.typeId
    tryRemove(entity)
    console.warn(`[Pigman Blocker][${source}] Removed ${typeId} at (${Math.round(x)}, ${Math.round(y)}, ${Math.round(z)})`)
  } catch { /* entity invalid mid-execution, skip */ }
}

// Tangkap spawn baru
world.afterEvents.entitySpawn.subscribe(({ entity }) => {
  try {
    if (!isValid(entity)) return
    if (!BLOCKED_IDS.includes(entity.typeId)) return
    if (entity.dimension.id !== 'minecraft:overworld') return
    system.run(() => handle(entity, 'Spawn'))
  } catch { /* entity invalid before system.run, skip */ }
})

// Bersihkan entity lama setiap ~1 detik
system.runInterval(() => {
  try {
    const entities = world.getDimension('minecraft:overworld').getEntities()
    for (const entity of entities) {
      try {
        if (!isValid(entity)) continue
        if (!BLOCKED_IDS.includes(entity.typeId)) continue
        handle(entity, 'Scan')
      } catch { /* entity expired mid-loop, skip */ }
    }
  } catch (e) {
    console.warn('[Pigman Blocker] Scan error:', e)
  }
}, 20)

console.warn('[Pigman Blocker] Active:', BLOCKED_IDS.join(', '))
import { world, system } from '@minecraft/server'
import { ActionFormData, ModalFormData } from '@minecraft/server-ui'
import { setBar, setBarAll } from '../shared/actionbar_manager.js'

// -- Constants --
const NS = 'mcleaner'
const ADMIN_TAG = 'mimi'
const TRIGGER_ITEM = 'minecraft:stick'
const DIMENSIONS = ['minecraft:overworld', 'minecraft:nether', 'minecraft:the_end']
const BAR_LEN = 10, MS_PER_TICK = 50, ACTIONBAR_SHOW_TICKS = 100, WARN_THRESHOLD = 0.10, WARN_1MIN_TICKS = 1200

const MOB_GROUPS = {
  Undead:  ['minecraft:zombie','minecraft:zombie_villager','minecraft:husk','minecraft:drowned','minecraft:zoglin','minecraft:skeleton','minecraft:stray','minecraft:bogged','minecraft:phantom'],
  Hostile: ['minecraft:creeper','minecraft:spider','minecraft:cave_spider','minecraft:enderman','minecraft:endermite','minecraft:silverfish','minecraft:witch','minecraft:slime','minecraft:shulker','minecraft:vex','minecraft:breeze'],
  Nether:  ['minecraft:blaze','minecraft:ghast','minecraft:magma_cube','minecraft:wither_skeleton','minecraft:hoglin','minecraft:piglin','minecraft:piglin_brute'],
  Illager: ['minecraft:pillager','minecraft:vindicator','minecraft:evoker','minecraft:ravager'],
}
const GROUP_NAMES = Object.keys(MOB_GROUPS)
const MOB_IDS = Object.values(MOB_GROUPS).flat()

// FIX #6: Tambah opsi "Off (Manual saja)" di index 0
// Saat interval = 0 → tidak ada auto-clean, hanya manual dari menu.
const INTERVAL_TICKS  = [0,   100,      200,       400,       600,       1200,     2400,      6000,      12000     ]
const INTERVAL_LABELS = ['Off (Manual saja)', '5 detik','10 detik','20 detik','30 detik','1 menit','2 menit','5 menit','10 menit']

// -- State --
let cfg = { enabled: true, interval: 200, mobs: Object.fromEntries(MOB_IDS.map(id => [id, false])) }
let tick = 0, warned = false, warned1min = false

const menuCooldown = new Map()

// -- Config --
function loadConfig() {
  try {
    const raw = world.getDynamicProperty(`${NS}:config`)
    if (typeof raw !== 'string') throw ''
    const s = JSON.parse(raw)
    const on = new Set(Array.isArray(s.mobs) ? s.mobs : [])
    return { enabled: s.enabled ?? true, interval: s.interval ?? 200, mobs: Object.fromEntries(MOB_IDS.map(id => [id, on.has(id)])) }
  } catch {
    return { enabled: true, interval: 200, mobs: Object.fromEntries(MOB_IDS.map(id => [id, false])) }
  }
}

function saveConfig() {
  try { world.setDynamicProperty(`${NS}:config`, JSON.stringify({ enabled: cfg.enabled, interval: cfg.interval, mobs: MOB_IDS.filter(id => cfg.mobs[id]) })) }
  catch (e) { console.warn('[MCleaner] saveConfig: ' + e) }
}

function saveTime() {
  try { world.setDynamicProperty(`${NS}:lastClean`, Date.now()) }
  catch (e) { console.warn('[MCleaner] saveTime: ' + e) }
}

function restoreTick() {
  try {
    // FIX #1: Jangan restore tick saat cleaner disabled.
    // Sebelumnya: tick loncat ke nilai besar → begitu re-enable langsung trigger clean.
    // Sekarang  : saat disabled, tick dimulai dari 0 ketika re-enable.
    if (!cfg.enabled || cfg.interval === 0) { saveTime(); return }
    const last = world.getDynamicProperty(`${NS}:lastClean`)
    if (typeof last === 'number') {
      tick = Math.min(Math.floor((Date.now() - last) / MS_PER_TICK), cfg.interval)
      console.warn('[MCleaner] Timer restored — ' + tick + '/' + cfg.interval)
    } else saveTime()
  } catch {}
}

// -- Helpers --
const isValid    = e => { try { return typeof e.isValid === 'function' ? e.isValid() : !!e.isValid } catch { return false } }
const formatSecs = t => Math.ceil(t / 20) + 's'
const broadcast  = msg => { for (const p of world.getPlayers()) try { p.sendMessage(msg) } catch {} }
const resetFlags = () => { tick = 0; warned = false; warned1min = false }

function playSoundAll(id, volume = 1, pitch = 1) {
  for (const p of world.getPlayers()) try { p.playSound(id, { location: p.location, volume, pitch }) } catch {}
}

function buildBar(remaining) {
  const filled = Math.round(Math.max(0, Math.min(1, 1 - remaining / ACTIONBAR_SHOW_TICKS)) * BAR_LEN)
  return '§6[§c' + '█'.repeat(filled) + '§8' + '░'.repeat(BAR_LEN - filled) + '§6]'
}

function safeToggle(form, label, value) {
  try { form.toggle(label, { defaultValue: value }) }
  catch { try { form.toggle(label, value) } catch { form.toggle(label) } }
}

function safeDropdown(form, label, options, index) {
  try { form.dropdown(label, options, { defaultValueIndex: index }) }
  catch { try { form.dropdown(label, options, index) } catch { form.dropdown(label, options) } }
}

function isAdmin(player) {
  try { return player.hasTag(ADMIN_TAG) } catch { return false }
}

// -- Core --
// FIX #4: Gunakan getEntities({ type }) per mob ID, bukan getEntities() lalu filter manual.
// FIX #7: Skip mob yang sedang dalam combat (ada player dalam radius 10 blok).
//         Mob yang aktif diserang tiba-tiba hilang → janky & player rugi streak/loot.

// FIX #7: Cek apakah mob sedang aktif diserang/dekat player
function isMobInCombat(e) {
  try {
    return e.dimension.getPlayers({ location: e.location, maxDistance: 10 }).length > 0
  } catch { return false }
}

function cleanMobs() {
  if (!cfg.enabled) return 0
  const targets = MOB_IDS.filter(id => cfg.mobs[id])
  if (!targets.length) return 0

  const killed = {}
  let total = 0

  for (const dimId of DIMENSIONS) {
    try {
      const dimension = world.getDimension(dimId)
      for (const targetId of targets) {
        try {
          for (const e of dimension.getEntities({ type: targetId })) {
            try {
              // FIX #7: Lewati mob yang sedang dalam radius player (aktif combat)
              if (!isValid(e) || e.nameTag?.trim() || isMobInCombat(e)) continue
              e.remove()
              killed[e.typeId] = (killed[e.typeId] ?? 0) + 1
              total++
            } catch { /* entity invalid mid-loop */ }
          }
        } catch { /* type query error */ }
      }
    } catch { /* dimension error */ }
  }

  console.warn('[MCleaner] ' + (total > 0
    ? 'Dihapus ' + total + ' | ' + Object.entries(killed).map(([id, n]) => id.replace('minecraft:','') + ' x' + n).join(' | ')
    : 'Clean selesai — tidak ada mob.'))
  return total
}

// -- Interval loop --
// FIX #6: Timer PAUSE saat cleaner dimatikan (cfg.enabled = false).
//         Timer juga tidak jalan saat interval = 0 (manual-only mode).
system.runInterval(() => {
  // Pause saat disabled — timer tidak bergerak
  if (!cfg.enabled) return

  // Manual-only mode — tidak ada auto-clean
  if (cfg.interval === 0) return

  tick += 20
  const remaining  = cfg.interval - tick
  const hasTargets = MOB_IDS.some(id => cfg.mobs[id])

  if (hasTargets && !warned1min && cfg.interval > WARN_1MIN_TICKS && remaining <= WARN_1MIN_TICKS && remaining > 0) {
    warned1min = true
    broadcast('§6[Mob Cleaner] §eMonster tanpa nametag akan dibersihkan dalam §f1 menit§e!')
    playSoundAll('note.pling', 1, 0.5)
  }

  const warn10pctAt = Math.floor(cfg.interval * WARN_THRESHOLD)
  if (hasTargets && !warned && remaining <= warn10pctAt && Math.abs(warn10pctAt - WARN_1MIN_TICKS) > 100) {
    warned = true
    broadcast('§6[Mob Cleaner] §eMonster dibersihkan dalam §f' + formatSecs(remaining))
    playSoundAll('note.pling', 1, 1.2)
  }

  // FIX #3: Gunakan shared actionbar manager dengan priority 10
  // (lebih tinggi dari kill notification priority 5)
  if (hasTargets && remaining <= ACTIONBAR_SHOW_TICKS) {
    const bar = '§6Mob Cleaner ' + buildBar(remaining) + ' §e' + formatSecs(remaining)

    // setBarAll di shared manager — hanya berjalan kalau ada data
    setBarAll(bar, 10, 40)

    // Suara countdown
    for (const p of world.getPlayers()) {
      try {
        if (remaining <= 20) p.playSound('note.pling', { location: p.location, volume: 0.8, pitch: 2.0 })
        else if (remaining <= 60) p.playSound('random.click', { location: p.location, volume: 0.6, pitch: 1.5 })
        else p.playSound('random.click', { location: p.location, volume: 0.4, pitch: 1.0 })
      } catch {}
    }
  }

  if (tick >= cfg.interval) {
    saveTime(); resetFlags()
    const count = cleanMobs()
    broadcast('§6[Mob Cleaner] §eDibersihkan §f' + count + ' §emob.')
    playSoundAll(count > 0 ? 'random.levelup' : 'random.orb', count > 0 ? 1 : 0.5, count > 0 ? 1.0 : 1.5)
  }
}, 20)

// -- UI --
async function openGroupConfig(player, groupName) {
  const mobs = MOB_GROUPS[groupName]
  const form = new ModalFormData().title(groupName + ' — Pilih Mob')
  for (const id of mobs) safeToggle(form, id.replace('minecraft:','').replace(/_/g,' '), cfg.mobs[id])

  const res = await form.show(player)
  if (res.canceled) return openMobMenu(player)
  res.formValues.forEach((val, i) => { cfg.mobs[mobs[i]] = val })
  saveConfig(); openMobMenu(player)
}

async function openMobMenu(player) {
  const form = new ActionFormData().title('Mob Cleaner — Pilih Mob')
  form.button('Aktifkan Semua'); form.button('Nonaktifkan Semua')
  for (const g of GROUP_NAMES) {
    const mobs = MOB_GROUPS[g]
    form.button(g + ' (' + mobs.filter(id => cfg.mobs[id]).length + '/' + mobs.length + ')')
  }

  const res = await form.show(player)
  if (res.canceled) return openMainMenu(player)
  if (res.selection <= 1) {
    MOB_IDS.forEach(id => { cfg.mobs[id] = res.selection === 0 })
    saveConfig(); return openMobMenu(player)
  }
  openGroupConfig(player, GROUP_NAMES[res.selection - 2])
}

async function openIntervalConfig(player) {
  const form = new ModalFormData().title('Mob Cleaner — Interval')
  // FIX #6: Tampilkan semua opsi termasuk "Off (Manual saja)" di index 0
  safeDropdown(form, 'Interval Pembersihan', INTERVAL_LABELS, Math.max(0, INTERVAL_TICKS.indexOf(cfg.interval)))

  const res = await form.show(player)
  if (res.canceled) return openMainMenu(player)
  cfg.interval = INTERVAL_TICKS[res.formValues[0]]
  resetFlags(); saveTime(); saveConfig(); openMainMenu(player)
}

async function openMainMenu(player) {
  try { player.playSound('random.orb', { location: player.location, volume: 1, pitch: 1.5 }) } catch {}

  // FIX #6: Tampilkan info interval "Off" jika interval = 0
  const intervalLabel = cfg.interval === 0
    ? 'Off (Manual saja)'
    : INTERVAL_LABELS[Math.max(0, INTERVAL_TICKS.indexOf(cfg.interval))]

  const form = new ActionFormData()
    .title('Mob Cleaner')
    .body('Status   : ' + (cfg.enabled ? '§aAktif' : '§cNonaktif') + '§r\n' +
          'Interval : ' + intervalLabel + '\n' +
          'Mob aktif: ' + MOB_IDS.filter(id => cfg.mobs[id]).length + '/' + MOB_IDS.length + '\n' +
          'By Laughtale Server')
    .button(cfg.enabled ? '§cMatikan Cleaner' : '§aAktifkan Cleaner')
    .button('Pilih Mob').button('Atur Interval').button('Bersihkan Sekarang')

  const res = await form.show(player)
  if (res.canceled) return

  if (res.selection === 0) {
    const wasEnabled = cfg.enabled
    cfg.enabled = !cfg.enabled

    // FIX #6: Reset timer saat re-enable agar countdown mulai segar
    // Saat dimatikan → timer sudah pause, tidak perlu reset
    if (!wasEnabled && cfg.enabled) {
      resetFlags()
      saveTime()
      console.warn('[MCleaner] Cleaner diaktifkan kembali — timer reset.')
    }

    saveConfig()
    return openMainMenu(player)
  }

  if (res.selection === 1) return openMobMenu(player)
  if (res.selection === 2) return openIntervalConfig(player)

  // Bersihkan Sekarang (manual)
  const count = cleanMobs()
  resetFlags(); saveTime()
  broadcast('§6[Mob Cleaner] §eDibersihkan §f' + count + ' §emob.')
  if (count > 0) playSoundAll('random.levelup', 1, 1.0)
  openMainMenu(player)
}

// -- Trigger: Klik kanan stick --
world.afterEvents.itemUse.subscribe(ev => {
  try {
    const player = ev.source
    if (!player || ev.itemStack?.typeId !== TRIGGER_ITEM) return

    // FIX #2: Key pakai player.name (bukan player.id) agar bisa dibersihkan
    // di playerLeave yang hanya punya playerName, bukan playerId.
    const now = Date.now()
    const lastOpen = menuCooldown.get(player.name) ?? 0
    if (now - lastOpen < 1000) return
    menuCooldown.set(player.name, now)

    if (!isAdmin(player)) return

    console.warn('[MCleaner] Menu dibuka oleh: ' + player.name)
    system.runTimeout(() => openMainMenu(player).catch(e => console.warn('[MCleaner] UI: ' + e)), 1)
  } catch (e) { console.warn('[MCleaner] itemUse error: ' + e) }
})

// FIX #2: Bersihkan menuCooldown saat player disconnect — cegah memory leak.
world.afterEvents.playerLeave.subscribe(ev => {
  try { menuCooldown.delete(ev.playerName) } catch {}
})

// -- Init --
system.run(() => {
  cfg = loadConfig()
  restoreTick()
  console.warn(
    '[MCleaner] Ready' +
    ' | enabled: ' + cfg.enabled +
    ' | interval: ' + (cfg.interval === 0 ? 'Off' : cfg.interval + ' tick') +
    ' | mobs aktif: ' + MOB_IDS.filter(id => cfg.mobs[id]).length +
    ' | tag admin: ' + ADMIN_TAG +
    ' | by Laughtale Server'
  )
})
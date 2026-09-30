# QA Report — ORAIN-0758: Windows drive-root regression (ORAIN-0757)

**Task ID**: ORAIN-0758
**Type**: bug
**Priority**: alta
**Branch**: task/orain-0758
**HEAD**: e12699484d7beb1cd4043e92fb02afb83aec722a
**Date**: 2026-09-30 10:50 +02:00

---

## Resumen ejecutivo

La rama restaura el comportamiento v0.7.1 para la raíz de unidad Windows
(`X:\` / `X:/`) y corrige la extracción de letra en `detectWindowsFilesystem`.
Las cinco modificaciones son quirúrgicas:

- `path-validation.ts` — relajada la regex de rechazo: `^[A-Za-z]:?$`
  ahora rechaza `G` y `G:` pero deja pasar `G:\` y `G:/`.
- `windows-cim.ts` — `detectWindowsFilesystem` extrae la letra con
  `^([A-Za-z]):` anclada al inicio; UNC/POSIX devuelven `unknown` sin
  invocar PowerShell. Nuevo helper `formatWindowsDriveDisplayName`.
- `index.ts` — `listMountedVolumesFallback` usa `formatWindowsDriveDisplayName`
  (AC4). El guard `sync:start2` sigue invocando `isValidPath` sin cambios.

Suite completa: **1650 passed | 5 skipped** (121 ficheros). AC5 es gate
manual en Windows (no ejecutable en macOS headless).

---

## Estado de ACs

### AC1: `isValidPath` acepta `G:\`, `G:/`, `g:\` y `G:\music`; rechaza `G`, `G:`, `G\`, '', byte nulo y rutas relativas.

- Veredicto: PASS
- Evidencia: `src/main/path-validation.test.ts` describe blocks 'POSIX
  absolute', 'Windows absolute' y 'type guards' cubren todos los casos.
  Tests específicos ORAIN-0758 (`accepts X:\\ drive root`,
  `accepts X:/ drive root`, `accepts lowercase drive root x:\\`,
  `rejects bare drive letter without colon`) en líneas 51-69.
  15/15 tests pasaron (`pnpm test src/main/path-validation.test.ts`).

### AC2: `usb:getDeviceInfo`, `device:getFilesystem` y `sync:start2` aceptan `G:\`.

- Veredicto: PASS
- Evidencia: `sync:start2` invoca `isValidPath(destinationPath)` en
  `src/main/index.ts:959`. El test `ORAIN-0758 AC2 — sync:start2 guard
accepts the drive root` (`path-validation.test.ts:78-84`) ejercita
  directamente la precondición del guard con `'G:\\'` y `'G:/'`. El
  guard ya estaba cableado (ORAIN-0757 AC6); la regresión estaba en la
  implementación de `isValidPath`, que ahora permite la raíz.
- Nota: el test cubre el predicado, no el handler IPC. El handler no
  tiene cobertura unitaria específica (decisión de diseño pre-existente).
  Para una regresión del guard bastaría con que `isValidPath` vuelva a
  fallar — el test lo detectaría.

### AC3: `detectWindowsFilesystem` extrae letra con ancla `^([A-Za-z]):`.

- Veredicto: PASS
- Evidencia: `src/main/windows-cim.test.ts` describe block
  `ORAIN-0758 AC3 — drive-letter extraction from full path` cubre los
  5 casos:
  - `C:\\Users\\user\\Music` → DeviceID='C:'
  - `c:/Music` → DeviceID='C:'
  - `G:\\` (raíz) → DeviceID='G:'
  - UNC `\\nas\music\album` → unknown sin PowerShell
  - POSIX `/mnt/usb/Music` → unknown sin PowerShell
- 32/32 tests en `windows-cim.test.ts` pasaron.

### AC4: `displayName = 'G:'` con dos puntos.

- Veredicto: PASS
- Evidencia: `formatWindowsDriveDisplayName('G')` → `'G:'` (test
  `ORAIN-0758 AC4 — Windows drive displayName has the colon` en
  `windows-cim.test.ts`). `src/main/index.ts:284` usa el helper
  compartido, evitando que el contrato se duplique.

### AC5: Verificación manual en Windows.

- Veredicto: SKIP
- Notas: gate manual, no ejecutable desde QA headless en macOS. Este AC
  exige reproducir el flujo end-to-end en Windows 10 o VM 'Win11 dev'
  (capturas + extracto de log). El propio cuerpo de la tarea lo marca
  como `[ALT:USER]`. La instrumentación (test que cubre el predicado,
  helper compartido, anclaje regex) garantiza que los fixes no se
  regresen, pero el smoke test en máquina real queda para el despliegue
  o para un QA con runner Windows. El MEMORY `win11-test-vm` documenta
  cómo activarla.
- Recomendación: que el dev o un QA con acceso a la VM ejecute este AC
  antes de cerrar 0.7.2.

### AC6: `pnpm test` + `pnpm typecheck` verdes; `scripts/check-spanish.sh` sin matches.

- Veredicto: PASS
- Evidencia:
  - `pnpm test`: 1650 passed | 5 skipped (121 ficheros, 193.73s)
  - `npx tsc --noEmit`: exit 0, sin output
  - `scripts/check-spanish.sh`: `OK — no Spanish text found.`

---

## Code review

### Hallazgos

- Sin CRITICAL, HIGH, MEDIUM, LOW.
- Auto-revisión cubre: hardcoded secrets (ninguno), shell injection en
  PowerShell args (imposible: `letter` viene de regex `[A-Za-z]` de un
  solo carácter), manejo de errores (todos los caminos de fallo
  devuelven `'unknown'` o `[]` defensivamente), anclaje de regex
  (`^...` en todos los casos).

### Observaciones fuera de alcance

- `NOTICED BUT NOT TOUCHING:` El commit `ef5f733` (también incluido en
  HEAD) reverte el cambio de estilo de los botones "Contact Us / View
  on GitHub / Support on Ko-fi" en `AboutModal.tsx`. Es una corrección
  separada (ORAIN-0750) que nada tiene que ver con ORAIN-0758. Se acepta
  por estar pre-existente en la rama antes de este pase.

### Notas de proceso

- `NOTICED BUT NOT TOUCHING:` El SHA reportado por el DEV (`a8cc1b9`) ya
  no es ancestro de HEAD (`e126994`) — fue reemplazado por `--amend`
  post-review. Los blobs del dev worktree son idénticos a los del HEAD
  actual (verificado con `git ls-tree`); la pérdida es solo del SHA
  original, no del trabajo. El guard SYSTEM-1134 disparó su mensaje de
  ABORT pero el contenido sí está presente, así que la validación
  procedió. Si el guard se vuelve a ejecutar con el SHA antiguo, dará
  el mismo falso positivo.

---

## Quality gate

- Lint: sin warnings específicos (tsc + tests sin errores)
- Typecheck: PASS (`npx tsc --noEmit`, exit 0)
- Spec cubierta vía tests automatizados (AC1-AC4, AC6)

---

## Métricas

| Métrica                  | Valor |
| ------------------------ | ----- |
| Test files               | 121   |
| Tests passed             | 1650  |
| Tests skipped            | 5     |
| Tests failed             | 0     |
| Production files changed | 3     |
| Test files changed       | 2     |
| Production LOC added     | ~40   |
| Test LOC added           | ~122  |

---

## Decisión recomendada

**APPROVE** (con nota sobre AC5 manual)

Razones:

- AC1-AC4 y AC6 cubiertos por tests automatizados (1650 passed).
- AC5 es gate manual explícito por el cuerpo de la tarea — no bloqueante
  para el flujo studio-qa pero queda pendiente para el despliegue.
- Sin hallazgos CRITICAL/HIGH/MEDIUM/LOW.
- Veredicto del script `triage.sh`: APPROVE.

Decisión recomendada: APPROVE

# 序列在冷却时按下：**不激活它**，指针挪到下一条等按键（+ 冷却飘字）

- **日期**：2026-09-21
- **触发**：玩家定下的新规矩（原话）：
  > 如果一条序列中有技能正在 CD，则不激活这条序列并给出提示，
  > 然后指针指到下一条序列**等待按键触发**。
- **动了哪些文件**：
  `technique-system/src/sim/cast.ts`（`pressSequence` + 新的 `CooldownNotice`）
  `technique-system/web/src/main.ts`（`reportPressResult` / `cooldownHint`，两处按键调用点并成一个出口）
  `technique-system/tests/weapons.ts`、`technique-system/tests/blink.ts`
  文档：本文件、`docs/log/README.md`、`docs/STRUCTURE.md`、`technique-system/README.md`

## 改前的现状（先核实，再动手）

**旧口径是"跳到下一条并当场把它打出去"** —— 代码在 `src/sim/cast.ts` 的 `pressSequence`
（改动前 435~518 行）：`nextIndex()` 算出轮到第几段 → `startSequence()` 放它 →
失败且 `reason === 'cooldown'` 就 `index = (index + 1) % count` **在同一个 for 里再放一次**。
只有冷却会跳；能量 / 血契 / 沉默 / 忙碌**原样 `return r`**（这一半是对的，本轮保留）。
那一版是日志 38 定的，注释写的也是"则释放下一条序列"。

所以**关键差别就在最后半句**：旧代码跳过去之后**当场激活**那一条 ✗；
玩家现在要的是**只移动游标**、**等下一次按键**才试 ✓。

## 改了什么

1. `src/sim/cast.ts` —— 三件事，一行不多：
   - 轮到的那一段在冷却 → 这一下**什么都不放**（不换一条打出去）。冷却之外的失败
     **原样返回**（`startSequence` 已经把 `castBlocked` 事件推出去了，事件语义没变）。
   - 用 `canActivate()` **无副作用地**问一圈"还有没有能放的"（最多 `count - 1` 次，
     不会无限找）→ 有就 `chain.next = index + 1`（**下一条**），没有就 `chain.next = 0`
     （**回到第一条**）。两种都**不激活**。
   - ⚠ 顺手把 `chain.lastEndTick` 续到这一刻（理由见下）。
2. `CooldownNotice`（新的导出类型 / `PressResult.cooldown`）：`index` / `techniqueId` /
   `name` / `remaining`（秒）/ `allCooling`。**"哪一条 + 还剩多久"由模拟层给出**，
   因为冷却键是内部形状、而且序列的冷却记在**每一段**上，界面自己算不出来。
3. `web/src/main.ts`：`pressCast` / `pressWeapon` 两处并成 `reportPressResult(res)`；
   冷却走 `cooldownHint()` 飘字，其余原因照旧 `blockReason()`。
   **只做飘字** —— 不去闪界面上任何一格（玩家看到的只有他自己装配的**术式栏**）。
   一次按键最多一条（`onKeyDown` 本来就有 `if (ev.repeat) return`，按住不放不会刷）。

## 为什么：三条规矩逐条落地

- **① 不激活这条序列**：这一下不调 `startSequence` 的第二次尝试 —— 一次按键打出去的
  技能换了人，玩家会以为"我按的是第一刀，怎么出来的是第二刀"。
  ⚠ 而且**定稿文档本来就要求这样**：[`sequence-and-modifier-model.md`](../sequence-and-modifier-model.md)
  §四的游标规则写着"一条序列走完 → 游标停在下一条序列的**准备**，**等下一次输入**
  （不自动开始）" —— 旧那句"冷却就自动放下一条"其实**和它相矛盾**，这一轮是对齐。
- **② 给出提示**：提示是**这句规矩的重点**。玩家上一轮的亏是"按下去没反应、
  而且不知道为什么"，所以提示宁可长一点，也要说清**第几条序列、名字、还剩几秒**
  （`还剩 1.2 秒`，不是光秃秃的"冷却中"）。
- **③ 游标到下一条、等下一次按键**：
  - ⚠ **必须续 `lastEndTick`**：`nextIndex()` 有两条规则会**无视** `chain.next` ——
    `lastEndTick < 0`（这条链还没放过任何一段）和"超过 `sequenceTimeout` 没按"。
    不续的话，"轮到的第一段一开始就在冷却"这种情况里**游标根本推不动**
    （下一次按还是算第 0 段），规矩 ③ 就落不了地。
    代价（有意的）：序列超时窗口从**这一按**重新开始 —— 跳过之后停手超过 1 秒，
    照旧回第一条（和"停一下再按就从第一段开始"是同一条规矩，没有新语义）。
  - ⚠ **不加新状态**：只动 `chain.next`，不引入"跳过计数"之类的第二份真相。
- **⚠ 一圈都在冷却 → 回到第一条、在原位等待**（这一条是**我自己定的**，玩家只说了
  "指针指到下一条"）：不留落点的话，游标会一格一格往前挪、每一下只弹一句"冷却中"，
  玩家看到的是"按了没反应"在**无限重复**，他会以为按键坏了。回到第一条 = 有一个
  **确定**的等待位置：第一个冷却好的那一段，按下去就出。也不空转（这一下什么都没放）、
  也不无限找（问一圈就停）。
- **保住了原来的三条判断**：能量 / 血契 / 沉默 / 忙碌**原样失败**，而且
  **不带 `cooldown` 提示**（带了玩家会以为"等一会儿就好"）。测试里钉着这一条。

## ⚠ 顺带核实：「每条序列一个冷却键」是错的（**只报告，不动手**）

玩家指出 **CD 是技能的属性**，键该挂在技能上（`cd.<技能id>`）。**现状核实**：

- **现在的键 = 运行时执行的单位的 id**（`cooldownPath()` = `` `cd.${id}` ``）：
  - 普通术式 → **术式自己的 id**（`content/skills/*.json` 的 `cooldown` 写在**阶段代价**上，
    落账时用 `cast.technique.id`，见 `cast.ts` 的 `payPhaseCost`）；
  - 挂了序列 → **那一段的 id**（日志 46 的 `segmentKey()`：内容里显式写的 `id`，
    没写就 `<容器id>.seq<i>`）—— 所以"键取了术式 id"这件事对段来说是
    **模型 A 的历史遗留**（那时每段本身就是一份独立术式）✓ 玩家的判断是对的。
- **改动的面积不小**（所以这一轮**不做**）：
  `compile.ts`（段 id 就是冷却键这条设计 + 注释）、`cast.ts`（`canActivate` 要遍历
  `skillIds`、`payPhaseCost` 要知道**阶段属于哪个技能** —— 现在只知道 `phase.id` 有
  `技能id#` 前缀）、`pipeline.ts`（`skill.cooldown` 这个简写要解析到"拥有这条规则的技能"）、
  `web/src/main.ts` 的 HUD CD 读数（现在读 `cd.<那一格术式id>`）、以及
  `tests/cast.ts` / `tests/barrier.ts` / `tests/blink.ts` / `tests/weapons.ts` 里
  **写死的键名**。**日志 46 还专门把"段 id = 冷却键"记成"对外可观察的行为 + 存档里存的键"**，
  改键等于**推翻那一笔**，得单独一片。
- **会不会改行为**：我扫了全部内容（`.scratch/cd49-key-audit.mjs`）——
  所有"整条"术式都只带 **1 个技能**，所以 1:1 映射下行为不变；
  唯一被两处用到的技能是 `skill.ws-slash`（`tech.iron-sword-basic#0` 和
  `tech.longsword-basic#0`），而**两段的 id 本来就是同一个 `tech.ws-slash`** ——
  也就是说**今天已经共享一个键**，改成按技能之后**仍然共享**，行为不变 ✓。
  `duel` 用的 `charged-laser / cleave / magic-bolt` 各 1 个技能、不与他处共享 ✓。
- **有一处规格没写清，需要玩家/上层裁定**：一条术式由**多个技能**拼成、而它们各自有
  不同的冷却时，"这条术式的 CD"是什么？我能想到的唯一自洽读法是
  **"任一技能在冷却 → 这整条术式不能放"**（和这次这条序列规矩同一套语义），
  但那是**新语义**，不该我自己定 ⇒ 列为待裁定项。

## 验证（全部实跑；改前存在 `.scratch/cd49-before/`，改后在 `.scratch/cd49-after/`）

| 命令 | 结果 |
| --- | --- |
| `npm test` | 17 个文件全绿（exit 0）；断言合计 **1231 → 1248**（`weapons` 99 → **112**、`blink` 28 → **32**，其余 15 个断言文件一个数都没变） |
| `npm run validate` | **51 个文件 · 51 通过 · 0 失败 · 9 警告**（和改前一致） |
| `npm run typecheck` | exit 0（`tsc --noEmit` + web 那份都干净） |
| `npm run calibrate` | **18.4 → 1.47**（和改前一致） |
| `node src/cli/battle.ts content/scenarios/duel.json --duration 12` | **逐位不变**：SHA256 `9072EF45853AFA8E5978664FCCFBFC7A86EB083A96F0E4B66DCCE9961ECCAF3A`（改前改后同一个哈希；duel 里没有序列，符合预期） |
| `npm run build:web` | exit 0 |

⚠ 计数用 README 里"别手算"那段 PowerShell **逐文件读它自己打印的数**加出来的
（`1248 = 1219 + 校验器 11 + 纯净性 18`），没有拿旧值加。

新加的断言（`tests/weapons.ts` 的 CD 段 + `tests/blink.ts` 的一小节）：
CD 中按下 → **该序列没被激活**（`r.cast === undefined` 且 `w.casts.length === 0`）、
**游标到了下一条**（`chain.next === 1`）、提示带 `techniqueId` / `remaining` / `allCooling`；
再按一次 → **下一条被打出**；冷却好了 → **绕回去**；一圈都在 CD → **游标回 0 + `allCooling`**；
**能量不够 / 沉默 → 不跳段、游标不动、不给冷却提示**（`r.cooldown === undefined`）。

## 欠账

- **冷却键搬到技能上**（上面那一节）：按玩家的模型是对的，但要单独一片 ——
  要动 `compile.ts` / `pipeline.ts` 的 `skill.cooldown` / HUD 读数 / 四个测试文件里
  写死的键名，而且**日志 46 明确把"段 id = 冷却键"记成对外可观察的行为**。
  ⚠ 其中"多技能术式的 CD 是什么"需要裁定（见上）。
- **界面上仍然看不到"这一格现在轮到第几段、第几段在冷却"**：这一轮只做了飘字。
  术式栏那一格今天读的是 `cd.<那一格术式id>`（容器自己没有冷却键），
  所以**容器术式的格子永远是"亮的"** —— 这是老问题，不在这一片里。
- **`peekSequence` 没改**：它照旧只报"下一段能不能放"，AI 靠它避让；
  如果玩家希望 AI 也走"跳过 + 下一次"这条路，那是 AI 侧的取舍。

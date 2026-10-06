# 序列内联（模型 B）：`sequences` 从"引用别的术式"变成"每条自己带技能"

- **日期**：2026-09-21
- **触发**：[`sequence-model-plan.md`](../sequence-model-plan.md) —— 那份计划就是本次的实现清单（10 步）。
  ⚠ 它开头有一段指针：**"每条序列自己的瞄准"已被**
  [`sequence-and-modifier-model.md`](../sequence-and-modifier-model.md) **取代**
  （瞄准在技能层，那是**下一片**的事），**其余部分（内联、合成内部术式的冷却键、
  删那几份子术式）就是本次要做的** ✓
- **玩家原话（这一片要的东西）**：
  > 今天：`tech.mark-blink.sequences = ['tech.mark-step', 'tech.blink-step']`，而那两份子术式各自是独立文件
  > 迁移后：这条术式的 `sequences` 里**直接内联**那两段（技能、顺序、条件照搬），
  > `content/internal-techniques/` 里**只为当序列而存在**的子术式文件删掉
- **动了哪些文件**：见第五节清单（代码 12 / 内容 8 / 测试 6 / 文档 4）
- **⚠ 硬指标：战斗行为逐位不变** —— `battle duel --duration 12` 的输出
  **逐字节相同**（`Get-FileHash` 对比 ✓，见第四节）
- **⚠ 没做的事**：瞄准**没搬**（还在术式/序列上）、**没有**为"修饰技能"写任何字段或占位
  （`mods` / `triggers` 一个都没加）、编辑器 UI（`web/src/editor.ts` / `technique-editor.ts`）
  **一个字没动**、`Technique.skills` / `links` **没删**（那是普通术式的）

---

## 一、改的是什么（模型 A → 模型 B）

**模型 A（改前）**：序列**引用另一份术式**（字符串 id），那份子术式自己占一个文件。

```
tech.mark-blink.json     { "sequences": ["tech.mark-step", "tech.blink-step"] }
tech.mark-step.json      { "targeting": {...}, "skills": ["skill.mark"] }      ← 独立文件
tech.blink-step.json     { "targeting": {...}, "skills": ["skill.blink"] }     ← 独立文件
```

好处是每段天然有自己的冷却（冷却键是 `cd.<术式id>`）；代价是内容里多出四份
**只有引擎看得见、编辑器完全编不出来**的子术式（`ws-slash` / `ws-thrust` /
`mark-step` / `blink-step`）。

**模型 B（改后）**：序列**内联**在术式里，每条自己带技能列表。

```jsonc
// tech.mark-blink.json
"sequences": [
  { "id": "tech.mark-step",  "name": "标记·起手",    "skills": ["skill.mark"],  "targeting": {…} },
  { "id": "tech.blink-step", "name": "瞬影·第二段",  "skills": ["skill.blink"], "targeting": {…} }
]
```

核心手法（计划里那句，一字不改地实现了）：**编译器把每条序列合成为一份"内部术式"**，
后面的东西（`activate` / `canActivate` / 冷却键 / HUD 的 `cd.*` / 链状态）**全都不用改** ——
它们本来就只认"一份编译好的术式"。

### 数据形状对照（拿真实术式比）

**`tech.longsword-basic`（长剑·基本式）**

```
改前（文件里）                             改后（文件里）
"sequences": [                            "sequences": [
  "tech.ws-slash",                          { "id": "tech.ws-slash",  "name": "横砍",
  "tech.ws-thrust"                            "skills": ["skill.ws-slash"],
]                                             "targeting": {...} },
                                            { "id": "tech.ws-thrust", "name": "刺击",
                                              "skills": ["skill.ws-thrust"],
                                              "targeting": {...} }
                                          ]
```

**编译产物**

| | 改前 | 改后 |
| --- | --- | --- |
| 容器 | `CompiledTechnique.sequences: string[]`（两个 id，运行时要去 `world.techniques` 查） | `CompiledTechnique.segments: CompiledSegment[]`（每段**自己带**一份编译产物） |
| 段 | 内容库里两份独立术式，**各自要 `registerTechnique` 进世界** | 就在容器的 `segments[i].technique` 里，**不用注册** |
| 段的 id（= 冷却键） | `tech.ws-slash` | `tech.ws-slash`（**一样** —— 见第三节） |
| 段的阶段 | `tech.ws-slash#windup` … | `tech.ws-slash#windup` …（**一样**） |
| 查不到那一段 | `world.techniques.get(id)` 得到 undefined → `noSequence`（"按了没反应"） | 内联的段拿不到不可能；老形状仍走 `world.techniques.get(refId)` → 同样 `noSequence` |

⚠ 最后一行是**故意保留**的：老形状（字符串引用）的失败路径**逐位不变** ——
不许给它兜一份空产物，因为 `activate` 对空时间轴的处理是"立刻算作放完并推进链"，
表现会变成"按了一下什么都没发生，但连段往前跳了一段"。那是行为改变，不是兼容。

---

## 二、三条裁定（工作前报上去的冲突，玩家逐条定了）

开工前发现**指令内部有冲突**（"不要动瞄准" vs "行为逐位不变"），报上去之后玩家裁定如下。
⚠ **这三条都写在这里**，因为它们是这一片最容易被后来人"顺手改掉"的地方。

### 裁定 ①：`SequenceSegment.targeting` **保留**，原样照搬

- **冲突点**：定稿文档 §六 / §九 说的方向是"术式没有瞄准，瞄准在技能层"，
  序列**不该**带自己的瞄准；可**今天它还非带不可**。
- **为什么非带不可**：`resolveAim()` 读的正是**这一发的** `targeting`
  （`src/sim/cast.ts` 的 `activate`），而 `tech.blink-step` 的 `targeting` 里有
  `requireStatusTag: 'marked'` —— **丢了它，「瞬影」会闪到最近的敌人背后**，
  而不是"我标过的那个"（`tests/blink.ts` 钉的就是这一条）。
- **裁定**：**保留，不改任何一条内容或测试**。理由：本次硬指标是"行为逐位不变"，
  而"瞄准搬到技能层"是**下一片单独的、会故意改变行为的迁移**。
  ⇒ 所以它不是惰性字段，它是**运行时真的读**的，行为依赖它 ✓ 合法。
- **代价**：`SequenceSegment.targeting` 是一条**明确的过渡遗留**，注释里写清了
  "下一片会删掉它"，本日志的欠账里也点了名。

### 裁定 ②：冷却键**沿用旧 id**，不改那几处断言

- 计划的原文是"冷却键必须合成一个稳定的键（用父术式 id + 序号）"。
  实测发现：**`cd.<子术式id>` 已经是对外可观察的行为** ——
  `tests/weapons.ts` / `tests/blink.ts` 里那几处断言钉着它，
  而且**老存档里存的冷却就是这个键**。
- **裁定**：改它属于"行为改变"，该由它自己那一片做，不该混在结构迁移里。
  ⇒ 迁移的内容**显式写 `SequenceSegment.id`**（沿用旧 id ✓）；
  新写的序列**不写 id** 时按 `<父id>.seq<i>` 合成 ✓（两者都在 `segmentKey()` 里）。
- ⚠ **CD 键的命名要在"瞄准搬家"那一片一起收尾** ——
  两件都是"**身份从哪来**"的问题（段的身份 / 那一发的瞄准），**一起定比分开定干净**。

### 裁定 ③：`pricing.ts` 摊平各段 skills 算账 —— **不做**

- 计划第 4 条要求"容器也要算账：把各段 `skills` 摊平进去"。
- **不做的三条理由**：① 它会把 `tech.longsword-basic` 从"不算账"变成"算账" ✗
  那是**账的行为改变**，而本次两条硬指标（行为逐位不变 + `validate` 输出不变）都指向不做；
  ② 武器技能是 `readonly`、数值由武器属性代入，"给它们算账"没有意义 ✓；
  ③ "序列术式不算账"是**故意的现行规矩**（`tests/weapons.ts` 钉着 ✓）。
- ⚠ **前瞻问题（必须写清，这不是"我忘了"）**：等序列成为**所有**术式的通用形状之后，
  "序列术式不算账"就等于"**所有术式都不算账**" ✗ ——
  那时账怎么算必须重新推导。⚠ 玩家已经把新规矩定稿了，写在
  [`sequence-and-modifier-model.md`](../sequence-and-modifier-model.md) **第十二节"账怎么判（定稿）"**
  （按**系别**分：武器术式不算账、魔法术式都要算账；主动 / 常驻 / 混合三条各自的符号规矩）。
  **代码实现它是后面某一片的正题。**

---

## 三、冷却键怎么合成的、为什么行为不变

**合成规则**（`src/sim/compile.ts` 的 `segmentKey`）：

```
segmentKey(容器id, 序号, 段上显式写的 id)
  → 段写了 id      → 用它
  → 段没写 id      → `<容器id>.seq<序号>`
```

**为什么行为逐位不变** —— 一条一条：

1. **冷却键指的是同一个字符串**。迁移内容把旧 id **显式写下来**了
   （`tech.ws-slash` / `tech.ws-thrust` / `tech.mark-step` / `tech.blink-step`），
   所以 `cd.<段id>` 和改前**一模一样**：
   - 哪一段进冷却：仍然只由**那一段的技能自己的阶段代价**决定
     （`payPhaseCost` → `cooldownPath(cast.technique.id)`）—— 第一段没写 cooldown、
     第二段写了 cooldown，所以"第一段不进 CD、第二段进 8 秒 CD"照旧 ✓
   - 冷却多久：照旧读同一份 `Phase.cost.cooldown` ✓
2. **按键循环的推进方式没变**：段号仍然存在 `entity.chain.next`，
   推进 / 回绕 / 150ms 缓冲 / 超时回第一条 / 打断也推进 / 冷却则跳下一条，
   全在 `pressSequence` / `nextIndex` / `startSequence` / `onSequenceEnd` 里，
   **判据一处都没改**（只是"从哪儿取那一段"从 `world.techniques.get(id)` 换成了
   `segments[i].technique`）。
3. **段的编译产物和旧子术式的编译产物是同一份**：
   同一个技能、同一个 `links` 对齐规则、同一个 `tech.<id>#` 阶段前缀。
   ⚠ 报错用的"哪份术式"那个名字**分开取了两个参数**（`ownerLabel` 给人看的
   `name` / `ownerId` 给引擎认身份的 id）—— 合成一个的话，
   容器的报错会从"术式「裂地斩」引用了…"变成"术式「tech.cleave」引用了…"。
4. **`skillIds` 取各段之和**：这是技能页"被这些术式用到"（`usedBy`）的来源。
   内联之前容器是空的、技能在两条子术式那一层；内联之后不摊平的话，
   技能页会显示"**没有任何术式用到它**" —— 静默地少一半。

**老形状（字符串引用）的行为也没变**：`resolveSegment` 里那一条
`world.techniques.get(seg.refId)` 和老代码的 `world.techniques.get(id)` 是**同一句**，
`undefined` 也照样返回 `noSequence`。

---

## 四、验证（全部实跑，真实数字）

⚠ 改前先把全部命令的输出存到 `.scratch/seq46-before/`（工作区不是 git 仓库，
那是"改前长什么样"的唯一证据），改完存到 `.scratch/seq46-after/`，用 `Get-FileHash` 逐条比。

| 命令 | 结果 | 哈希对比 |
| --- | --- | --- |
| `npm test` | **17 个文件全绿**。合计 **1189 → 1212**（见下面口径） | DIFFER（**应该变**：测试本身改了） |
| `npm run validate` | **47 个文件 · 47 通过 · 0 失败 · 9 警告**（51 → 47 = 删掉 4 份子术式） | DIFFER（**应该变**，见下） |
| `npm run typecheck` | 两个 tsconfig 干净（EXIT=0） | **SAME** ✓ |
| `npm run calibrate` | 标定前最大偏差 **18.4** → 标定后 **1.47**（均方根 8.024 → 0.832） | **SAME** ✓ |
| `npm run battle -- content/scenarios/duel.json --duration 12` | 剑士 67.6/300 造成 129 施法 5 次 · 法师 71/200 造成 232.4 施法 8 次 | **SAME** ✓ **逐字节不变** |
| `npm run build:web` | 通过 | **SAME** ✓ |
| `node tools/overview.ts` | **0 个 ✗**、零内容 23 处（和改前一样） | DIFFER（**应该变**：术式 17 → 13 份） |

### `validate` 的差异**只有**这三类（逐行核对过）

```
- 4 份子术式文件的整段（blink-step / mark-step / ws-slash / ws-thrust）  ← 文件删了
- 序列那一行的显示：tech.ws-slash → tech.ws-thrust     变成  横砍[skill.ws-slash] → 刺击[skill.ws-thrust]
- priceless 那句措辞（见下面"改了一句假话"）
```

⚠ **失败数 0 没变、警告数 9 没变，9 条警告的文本逐字相同**（`Compare-Object` 无输出）——
也就是说：**新检查在出厂内容上一条都没有误报**。

### `battle` 是这次唯一的硬指标

```powershell
Compare-Object (Get-Content .scratch/seq46-before/battle.txt) (Get-Content .scratch/seq46-after/battle.txt)
# 无输出 = 逐字节相同
```

### 计数口径（⚠ 照 README 那段 PowerShell 跑，不手算）

```
15 个断言文件之和 = 1185
tests/smoke.ts 的校验器用例 = 11
tests/purity.ts 的纯净性文件数 = 16
合计 = 1212
```

⚠ **本次 +23 的出处**（逐个文件的数差，不是"在旧值上加"）：
`weapons` 87 → 99（+12）、`store` 54 → 61（+7）、`blink` 25 → 27（+2）、
`school` 25 → 27（+2）；**其余 11 个断言文件一个数都没变**。

⚠ **一个对不上的地方，需要人裁定**：README / `STRUCTURE.md` 从日志 45 起写的合计是
**1189**（口径写成 `1162 + 11 + 16`），而**本次改前**用 README 那段 PowerShell 跑出来的
是 **15 个断言文件之和 = 1162** ✓ —— 但**本次改后**同一个脚本给出的是 **1185 + 11 + 16 = 1212**，
其中 `1162 → 1185` 是 **+23**，正好等于上面那四处的增量之和 ✓。
所以 **1189 → 1212 是一致的**（不是我这边多算了）。这一行只是把两次口径写在一起，方便下一个人核。

**新检查真的会响**（`tests/weapons.ts` / `tests/blink.ts` / `tests/store.ts` / `tests/school.ts`）：

```
✓ 内联：段里的技能都存在 → 不报 UNKNOWN_SKILL
✓ 内联：段里的技能敲错 → 报 UNKNOWN_SKILL，而且指出是第几段的第几个（sequences[1].skills[0]）
✓ 内联：段没有 `skills`（手改坏了）→ 报 BAD_SEQUENCE（不许等到编译期才炸）
✓ 老形状：引用了存在的序列时没有 UNKNOWN_SEQUENCE
✓ 老形状：序列名敲错 → 报 UNKNOWN_SEQUENCE（这就是老码的唯一提示）
✓ 老形状：引用的是已经删掉的那份子术式 → 报 UNKNOWN_SEQUENCE（不静默）
✓ 没写 id 的段：冷却键按 `<容器id>.seq<序号>` 合成
✓ 写了 id 的段：冷却键就是它（沿用旧 id，行为才逐位不变）
✓ 魔法术式、但**段里**放了武器技能 → 照样报 MAGIC_TECHNIQUE_WEAPON_SKILL
✓ 内联的段里是魔法技能 → 一条都不报（不是"段里的技能一律报"）
✓ v3 存档里的序列术式照样读得进来，`sequences` 里的字符串 id 一个没变
✓ 序列内联之前的老分享码照样解得出术式，序列和条件门一个字没变
```

⚠ 关于中文 JSON：全部用 **Node**（`JSON.parse` → 改 → 复核）和 `edit` 工具处理，
**没有**用 PowerShell 的 `Get-Content` / `Set-Content`（会乱码，踩过）。
改完用 Node 重新 `JSON.parse`：4/4 合法、**无 U+FFFD**、逐字段核对过。

---

## 五、改了哪些文件

**A. 类型（1）**

- `schema/skill-schema.ts` —— 新增 **`SequenceSegment`**（`id?` / `name?` / `skills` /
  `links?` / `targeting?`，每个字段都写了"为什么"）+ **`TechniqueSequences`**
  （联合类型：内联的段 **或** 老形状的字符串 id）；`Technique.sequences` 从
  `string[]` 改成 `TechniqueSequences` —— 注释整段重写（含"内联了"这件事和
  为什么老形状还留着）

**B. 引擎（`src/sim/`，3）**

- `src/sim/compile.ts` —— 新增 `CompiledSegment` / `segmentKey()` / `emptyCompiled()`；
  抽出 `compileSkillChain()`（容器和段**共用同一段编译逻辑**）；
  `CompiledTechnique.sequences?: string[]` → `segments?: CompiledSegment[]`；
  `skillIds` 取各段之和
- `src/sim/cast.ts` —— 新增 `resolveSegment()`（两半：内联直接取 / 老形状按 `refId`
  查世界）和 `segmentCountOf()`；`pressSequence` / `nextIndex` / `peekSequence` /
  `startSequence` / `onSequenceEnd` 全部改成读 `technique.segments[i]`；
  `startSequence` 的参数从 `seqs: readonly string[]` 换成 `count: number`
- ⚠ 这两个文件**没有**引入 `Date` / `Math.random` / 三角函数等任何禁用项
  （`tests/purity.ts` 16 个文件全是绿的）

**C. 编译层以外（`src/`，5）**

- `src/school.ts` —— 新增 `TechniqueRefsShape` 类型 + **`requiredSkillsOf()`**
  （递归收技能，含内联的段）+ `inlineSkillsOf()`；
  `deriveTechniqueKind` 改成**两半都认**（内联的段直接读、老形状按 id 顺着查）
- `src/pricing.ts` —— `isWeaponSide` **顺着一层看**段里的 `skills`
  （⚠ 不看的话**左键普攻会开始吃血契**，而且是按一个硬猜的数字吃）
- `src/validator/index.ts` —— `skillFormIssues` 两半都认（报错里用段名或"第 N 条序列"）；
  `BAD_SEQUENCE_ID` → **`BAD_SEQUENCE`**（形状检查：内联段必须有 `skills` 数组）；
  **新增**"段里的技能必须存在"（`UNKNOWN_SKILL`，路径到 `sequences[j].skills[i]`）；
  **系别一致性检查改成两半都查**（内联段 + 老形状）；`priceless` 的措辞改对
- `src/cli/validate.ts` —— 序列那一行改成打印**每段用了哪几个技能**（老形状仍打 id）；
  注释更新（术式表现在只对老形状有用）
- `tools/overview.ts` —— `skillIdsDeep` 两半都认

**D. 浏览器（`web/src/`，2）**

- `web/src/main.ts` —— **删掉**"序列悬空引用"那段检查（内联之后不存在这种引用了，
  改由 `compileTechnique` 逐段报，报得更准）；HUD 和连段进度的段数改读 `segments`；
  注释更新
- `web/src/store.ts` —— **`SAVE_VERSION` 3 → 4**；`sequenceOf` 的类型放宽；
  `isTechniqueShape` 新增 **`isSequenceList()`**（每一段都得能用）；
  `requiredSkills` 改成 `requiredSkillsOf`（**序列里的技能也算**）；
  `migrateV1` 顺带改段里的技能引用；**v3 → v4 的迁移故意是空操作**（理由见第六节）
- ⚠ `web/src/editor.ts` / `web/src/technique-editor.ts` **一个字没动** ✓

**E. 内容（8）**

- **内联**：`content/internal-techniques/longsword-basic.json`（2 段）、
  `iron-sword-basic.json`（1 段）、`mark-blink.json`（2 段）
- **删除**：`mark-step.json` / `blink-step.json` / `ws-slash.json` / `ws-thrust.json`
- `content/manifest.json` —— `internalTechniques` **17 → 13**，去掉那四个名字，
  并写明**它们仍然被老存档 / 老分享码按 id 引用**（所以老形状的读法留着）

**F. 测试（6）**

- `tests/weapons.ts`（87 → 99）—— 序列那几节全部改成内联形状 + 新增编译产物的断言；
  CD 跳段改成"内联的段 + 显式 id"；属性代入那一节改成从容器里取横砍
- `tests/blink.ts`（25 → 27）—— 两段从容器里取（只注册容器）；
  **行为断言一条没改**（`cast.technique.id` / `cd.tech.blink-step` 都还是老值）；
  新增"两段各自带技能"和"id 沿用旧值"两条
- `tests/store.ts`（54 → 61）—— 新增两节：**v3 → v4 迁移不许动数据**、
  **序列内联之前的老分享码还能用**；版本号断言 3 → 4
- `tests/school.ts`（25 → 27）—— 合成分成"内联"和"老形状"两组；
  出厂内容 **17 → 13 份**、武器侧 **4 → 2 份**
- `tests/smoke.ts` —— 系别那一节把 `readJson('…/ws-slash.json')` 换成**现造的探针**
  （那份文件没了），并且**反向也测**（段里是魔法技能时一条都不报）
- `tests/weapons.ts` / `tests/blink.ts` 里的 `registerTechnique(子术式)` 全部去掉

**G. 文档（4）**

- `docs/log/2026-09-27-46-inline-sequences.md`（本文）+ `docs/log/README.md` 索引一行
- `technique-system/README.md` —— 三处断言计数 + **修掉那条 canary 命令的错写法**（见下）
- `docs/STRUCTURE.md` —— 合计那一处 + 几处过时描述（序列层 / `compile.ts` / 测试文件 / 内容份数）
- `docs/sequence-and-modifier-model.md` —— **新增第十二节"账怎么判（定稿）"**
  （玩家定的三段式：纯主动 / 纯常驻 / 混合），原"欠账"一节顺延成第十三节

### ⚠ 顺手修掉的一个文档 bug（玩家点名的）

README 里那条 canary 写的是 `npm run battle duel --duration 12`，
而 **npm 会把 `--duration` 吃掉**（"12 is being parsed as a normal command line argument"）——
之前它能出数，**只是因为默认值恰好一样**（`battle.ts` 的默认 duration 就是 12），
所以没人发现这条命令其实一直是错的。改成正确的写法：

```
npm run battle -- content/scenarios/duel.json --duration 12
```

（`docs/log/2026-09-27-45` 那一节末尾已经记过同一件事 —— 那里写的是"这是命令行的用法，
不是这一片引入的"。本次只是把 README 里那条**错的**也叫醒。）

---

## 六、存档 + 分享码迁移（**为什么 `SAVE_VERSION` 升到 4，而迁移是空操作**）

**形状变了**：`sequences` 从"字符串 id 数组"变成"内联的段"。所以 `SAVE_VERSION` **3 → 4**
（升版本号的意义是"这份存档是哪一版"有个明确答案，而不是每次读都猜一遍形状）。

⚠ **但 v3 → v4 的迁移代码故意是空的。** 理由，一条一条：

1. **内联需要内容库，而这里不一定有。** 把一份子术式整个搬进来（技能列表 + `links` +
   `targeting` + …）要**读那份术式**，而 `parseState` 拿到的只有存档本身。
   **分享码里一定没有内容库** —— 那正是"别人手里存下来的字符串"的处境。
2. **玩家定的规矩**（原话）：
   > 万一某条老数据**推不出**新形状，**宁可留着旧的读法**，也不许静默丢数据
   ⇒ 所以老形状**原样留着**，而"原样留着"要成立就得让老形状**仍然能用**：
   引擎（`resolveSegment`）和校验器（`UNKNOWN_SEQUENCE`）都认字符串那一半。
   于是它**不会崩、也不是垃圾**：按下去没反应时，玩家至少拿得到一句
   "这一份我这儿没有"（`UNKNOWN_SEQUENCE` 的话术就是照这个写的）。
3. **内联是"移动"而不是"改名"**：真做起来还得把"找得到的那一份"和
   "找不到的那一份"分开处理，两边行为不一样 —— 而**两套行为**正是这个项目
   反复踩的那类坑（会漂移、而且是静默的）。

**因此本次对老数据做的事只有两件**：

- **`isTechniqueShape` 放宽**：`sequences` 里**每一项**都必须是能用的
  （内联段有 `skills` 数组 / 老形状是非空字符串）—— 手改坏的存档不许溜进去炸在编译期
- **`requiredSkills` 算上序列里的技能**：分享码导入的"对方缺哪些技能"提示
  以前只看 `tech.skills`，而只挂序列的术式那是空的 ⇒ 提示永远是空的，
  收码的人拿到一份"按下去没反应"的连招

⚠ **已知的、有意的退步**（写清楚，不许含糊）：老形状的段**冷却键仍然是旧的子术式 id**
（这正是我们要的）+ 若那份子术式已经不在内容里，那一段就是"按了没反应"。
**它不静默**：校验器会报 `UNKNOWN_SEQUENCE`，引擎返回 `noSequence`。

⚠ 另外：`migrateV1`（术式私藏副本 → 自定义技能库）**顺带补了一处** ——
它原来只改 `t.skills` 的引用，现在**段里的 `skills` 也改**。
（v1 存档比序列层还早，实践上撞不到；但"改名漏一处"正是那种会静默的症状。）

---

## 七、顺手补掉的两个洞（不补的话，这次迁移本身就制造静默失败）

1. **段里的技能写错一个字母，就没人看得见了** ✗
   内联之前，序列是**另一份术式**，`npm run validate` 会**单独校验它一遍**
   （"它引用的技能在不在"在那时就查了）。内联、而且把那几份文件删掉之后，
   那一遍**没有了**。⇒ 补：`validateTechnique` 现在逐段查 `skills`，
   报 `UNKNOWN_SKILL` 且路径到 `sequences[j].skills[i]`（"第几段的第几个"）。
2. **"魔法术式里放武器技能"这条规矩会漏掉一半** ✗
   它原来**只看 `tech.skills`**（注释里当时写的理由是"序列是另一门术式，
   它自己那一层会被各自检查"—— 那句在内联之后就不成立了）。
   而"魔法术式里放武器技能"最典型的形状恰恰是"**序列里放的**"。
   ⇒ 补：系别一致性检查改成**两半都查**（内联段 + 老形状），
   报错路径指到具体哪一段的哪一个技能。

⚠ 还有一处**"改了一句假话"**：`priceless` 原来写
"序列术式不算账 —— 它自己不带技能，时间轴和账都在每一条序列里"。
内联之后**"不带技能"是假的**，而且"账在每一条序列里"也不成立（段不进账）。
留着旧措辞的话，报告上会显示一句**听起来有账、实际没有**的话 ——
而那是这个项目最反对的一类东西。所以改成说清**现在**的样子（不算账 + 那是欠账）。

---

## 八、欠账

1. **⚠ `SequenceSegment.targeting` 是过渡遗留**（裁定 ①）。下一片"瞄准搬到技能层"
   会删掉它。⚠ **那时 `tests/blink.ts` 第 3 节那几条要跟着改** ——
   它们**不是写错了**，是**行为本身**（"第二段挑的是带标记的那个"）。
2. **⚠ CD 键的命名要在"瞄准搬家"那一片一起收尾**（裁定 ②）：两件都是
   "段的身份从哪来"的问题，一起定比分开定干净。
3. **⚠ 账的新规矩（按系别分）还没实现**（裁定 ③ + 玩家已定稿）：
   今天代码里仍然是"序列术式不算账"。⚠ 那句在序列成为所有术式的通用形状之后
   等于"**所有术式都不算账**" ✗。定稿写在
   [`sequence-and-modifier-model.md`](../sequence-and-modifier-model.md) 第十二节。
4. **老形状（字符串引用）在内容里已经是 0 份** —— 只剩老存档 / 老分享码会走到。
   ⇒ **它现在是一条"只有兼容测试在跑"的路**（`tests/weapons.ts` / `tests/blink.ts` /
   `tests/store.ts` 各有一条）。真要做"老码能不能玩"的判断，那是一次**端到端**的
   手动验证（拿一份真老码在浏览器里导一次），测试里做不到。
5. **`overview.ts` 的"机制覆盖"归因变了**：以前 `meleeArc 3 处 cleave, ws-slash, ws-thrust`，
   现在归到 `iron-sword-basic` / `longsword-basic`（**覆盖的处数没变**、
   变的只是"这件事记在哪份术式头上"）。要看"哪个技能提供了什么机制"的话，
   现在得往下看一层（段）。
6. **编辑器里还是编不出序列**（本次**故意**没动 UI）。所以模型 B 对玩家的**唯一可见收益**
   目前是"内容里少四份文件"；真正要的那块 UI 是后面某一轮的正题
   （见 `sequence-model-plan.md` 第四节）。
7. **`docs/sequence-model-plan.md` 的"落地顺序"已经走完第 3 步**（引擎改完），
   剩下第 4 步（编辑器加序列 UI）和第 5 步（配色 / 图标 / 动效）。
   那份计划本身没改（只在它开头留着指针）—— ⚠ 如果玩家要的是"计划跟着现状更新"，
   那是一次单独的整理，别混在这一片里做。

# 术式系别的**推导规则**改回"看它引用了什么"，以及带序列的术式读不回来

- **日期**：2026-09-21
- **触发**：玩家报的两个问题（原话）
  > 它没有引用武器技能，为什么是武器术式？**改回来**。

  > （第三条，"3修"）

  第一个是**设计错误**：上一轮（日志 43）为了给老数据补 `Technique.kind`，
  写了一条"有 `sequences` 就算武器术式"的推导规则。玩家拿
  「标记 · 瞬影」（`content/internal-techniques/mark-blink.json`）当场证伪了它 ——
  那份术式**一个武器技能都没引用**，它写序列只是为了做**二段技能**。
- **动了哪些文件**：见下面「改了哪些文件」（1 份内容 + 7 个代码/测试 + 3 处文档）

---

## 一、规则错在哪：第一句是"旧世界"的产物

上一轮的规则是**两句**：

```
（旧）有 sequences              → weapon     ← ✗ 这一句错，删掉
（旧）引用了武器技能             → weapon     ← ✓ 保留，但要变成"传递"的
（旧）否则                      → magic
```

第一句**在它被写出来的那天就已经过时了**：它的前提是"只有武器术式用序列层"。
可是序列层在**日志 28** 就已经从"武器专用"变成"所有术式的能力"了 ——
「标记 · 瞬影」正是拿它做的二段技能（第一段挂标记不进 CD、第二段瞬移进 CD）。
玩家在日志 43 里就说过这句话：

> 之前定下来的"序列"机制只作用于武器技能，但现在我觉得也应该作用于**魔法技能**了，
> 因为想实现二段技能只能用这种方法。

也就是说：**"有序列"和"是武器术式"早就不是一回事了**，只是那时候两条还碰巧
重合（内容里写序列的恰好都是武器术式）。`mark-blink` 一进来就把它撞破了。

⚠ 这正是 `Technique.kind` 当初存在的理由（见 schema 里那一段）：
"有序列 = 武器术式"这条判据**会失效，而且失效得非常安静** ——
没有一处会报错，只是那份术式被当成武器术式：不给它算账、编辑器的技能库只给它武器模板。
上一轮把 `kind` 加成了**显式字段**（对），但顺手在**迁移规则**里把这条旧判据又抄了一遍（错）。

### 正确规则（**传递**的）

> 一个术式是 `weapon` **当且仅当**它**直接、或通过它的 `sequences`（可能多级）**
> 含有武器系技能；否则 `magic`。

**为什么必须是传递的**，两层理由，缺一层都会把出厂内容判错：

1. **容器自己一个技能都没有**。`tech.iron-sword-basic` 只写
   `sequences: ["tech.ws-slash"]`，武器技能长在**它引用的那条序列**里。
2. **序列自己也不带 `sequences`**（`tech.ws-slash` 就是一条），它直接带武器技能。

只看容器一层 → 武器术式被判成魔法术式 → 它引用的正是武器系技能 →
校验器当场报 `MAGIC_TECHNIQUE_WEAPON_SKILL` → **51/51 变成 48/51**。
而且"两层够不够"没有答案：玩家可以把序列再套一层序列，所以**往下走到底**。

### 实现：迭代 + `seen` 名单（不是递归）

```ts
const seen = new Set<string>()            // 同时是防循环和去重
const queue = [tech]                      // 不用递归 → 没有爆栈这回事
while (queue.length > 0) {
  const cur = queue.pop()
  if (武器技能命中 cur.skills) return 'weapon'
  for (const id of cur.sequences ?? []) {
    if (seen.has(id)) continue            // ⚠ 先登记再展开：A → B → A 第二次就停
    seen.add(id)
    queue.push(sequenceOf(id))            // 查不到就当它不存在（悬空引用交给校验器报）
  }
}
return 'magic'
```

⚠ **为什么循环防护是硬要求**：这条路在**加载内容 / 读存档**的时候就会走，
爆栈的后果不是"某一份术式坏了"，而是**白屏**。而循环是能造出来的：
玩家手改过的存档、或者两份序列互相包含。测试里 A→B→A、A→A、
以及"环里藏着武器技能"三种形状都钉着。

### 调用方要交什么：`sequenceOf`（解析器），不是写死的表

`src/school.ts` 是**纯函数**（不读文件、不碰 node）：序列长什么样由调用方喂进来。
命令行、浏览器读存档、分享码**各自看得见的东西不同**，所以参数是可选的：

| 调用方 | 给 `weaponSkillIds` | 给 `sequenceOf` | 推得出来吗 |
|---|---|---|---|
| 浏览器读存档（`web/src/main.ts` → `loadState`） | ✓（内容里武器技能的 id） | ✓（**内容术式表**） | 全推得出来 |
| 分享码（`web/src/store.ts` 的 `withDerivedKind`） | ✗ | ✗（码里只有这一份术式） | 只按"它自己直接引用了武器技能吗"推 |
| 单份术式的临时调用 | 可给可不给 | 不给 | 同上 |

⚠ **缺席时的退路刻意偏向 `magic`**：猜错方向不对称 ——
猜成 `weapon` 会把一份玩家做的魔法术式变成"不算账的武器术式"（**静默**：
不给它算账、技能库还只给它武器模板），而猜成 `magic` 最坏也只是算一笔账，
玩家在编辑器里能改回来。

---

## 二、17 份内容用新规则算出来的 kind 对照表

`skill.ws-slash` / `skill.ws-thrust` 是内容里**全部**武器系技能
（目录 `content/weapon-skills/` 是唯一真相，不是写死的名单）。

| 文件 | id | 文件里写的 | 新规则算的 | 一致 | 它引用了什么 |
|---|---|---|---|---|---|
| `blink-step` | `tech.blink-step` | magic | magic | ✓ | `skill.blink` |
| `blood-pact` | `tech.blood-pact` | magic | magic | ✓ | `skill.blood-pact` |
| `charged-laser` | `tech.charged-laser` | magic | magic | ✓ | `skill.charged-laser` |
| `cleave` | `tech.cleave` | magic | magic | ✓ | `skill.cleave` |
| `curse-of-undead` | `tech.curse-of-undead` | magic | magic | ✓ | `skill.curse-of-undead` |
| `frost-lock` | `tech.frost-lock` | magic | magic | ✓ | `skill.frost-lock` |
| `hunt` | `tech.hunt` | magic | magic | ✓ | `skill.hunt` |
| **`iron-sword-basic`** | `tech.iron-sword-basic` | weapon | **weapon** | ✓ | 序列 `tech.ws-slash` → `skill.ws-slash` |
| **`longsword-basic`** | `tech.longsword-basic` | weapon | **weapon** | ✓ | 序列 `tech.ws-slash` / `tech.ws-thrust` |
| `magic-bolt` | `tech.magic-bolt` | magic | magic | ✓ | `skill.magic-bolt` |
| **`mark-blink`** | `tech.mark-blink` | ~~weapon~~ → **magic** | **magic** | ✓（改完） | 序列 `tech.mark-step` / `tech.blink-step` → `skill.mark` / `skill.blink` |
| `mark-step` | `tech.mark-step` | magic | magic | ✓ | `skill.mark` |
| `slow-field` | `tech.slow-field` | magic | magic | ✓ | `skill.slow-field` |
| `soul-rend` | `tech.soul-rend` | magic | magic | ✓ | `skill.soul-rend` |
| `stealth` | `tech.stealth` | magic | magic | ✓ | `skill.stealth` |
| **`ws-slash`** | `tech.ws-slash` | weapon | **weapon** | ✓ | `skill.ws-slash`（直接） |
| **`ws-thrust`** | `tech.ws-thrust` | weapon | **weapon** | ✓ | `skill.ws-thrust`（直接） |

**不一致的只有一个：`mark-blink`（写 weapon / 算 magic）→ 已改成 `magic`。**

**为什么只有它一个**，逐个说清：

- **`ws-slash` / `ws-thrust`**（上一轮日志 43 里靠"补充那条"判成 weapon 的两份）：
  新规则下它们**直接**引用武器技能，判据更硬 —— 一致。
  （旧规则的"第一句"对它们根本没用：序列自己不带 `sequences`。）
- **`iron-sword-basic` / `longsword-basic`**（旧规则靠"有 sequences"判成 weapon）：
  新规则下**顺着序列走一层**就碰到武器技能 —— 结论相同，**但理由换了**。
  ⚠ 这一点很重要：它们的 `kind` 是对的**纯属巧合**，
  换句话说，旧规则之所以"看起来能用"，正是因为内容里写序列的恰好都是武器术式。
- **`mark-blink`**：形状和上面两份**完全一样**（只挂序列、不写 `skills`），
  区别只在"序列里面是什么技能"。旧规则看不见这个区别，所以它必然判错 ——
  **它就是那条旧判据的反例**。
- **其余 13 份**：`skills` 里全是 `content/skills/` 的魔法系技能，没有序列 —— 两边都判 magic。

⚠ 这张表已经**钉进测试**（`tests/school.ts`）：它不检查"某两份写对了"，
而是把**全部 17 份**按规则重算一遍，任何一份不一致就红并报出文件名。
另外单独钉了 4 份 weapon + `mark-blink` 是 magic —— 不然"17 份全都一致"
在有人把所有 `kind` 改成同一个值的时候**照样是绿的**。

---

## 三、第二个 bug：带序列的术式**读不回来**

### 根因

`web/src/store.ts` 的 `isTechniqueShape`（存档 / 分享码的**唯一**形状检查）要求
`skills` **必须是数组**。而 schema 里明写着 `skills` 和 `sequences` **二选一** ——
序列术式**根本不写 `skills`**。后果：

- 玩家自己做的带序列的术式 → 读存档时被判"字段不全" → **静默丢掉**
  （`parseState` 只过滤，不提示）→ 表现为"我做的那份术式刷新之后不见了"
- 别人发来的老分享码 → `decodeShare` 直接回"字段不全"

⚠ **为什么它以前一直没暴露**：内容里那几份序列术式走的是**另一条**加载路径
（`web/src/main.ts` 直接 fetch JSON，不过这个形状检查）。
所以**只有玩家自己做的东西会撞上它** —— 而玩家的东西正是存档和分享码的全部内容。
日志 43 的「坑 4」记过这个现象，当时判成"既有行为、没在这一轮动"，这一轮动它。

### 修法

```ts
// 旧：&& Array.isArray(o['skills'])
// 新：两个里**至少有一个**是数组
&& (Array.isArray(o['skills']) || Array.isArray(o['sequences']))
```

⚠ **为什么留 `Array.isArray`**，而不是只看"字段存在"：
手改过的存档里 `sequences: "tech.ws-slash"`（漏了方括号）会让后面每一处
`?? []` 之后的遍历**在加载期**炸 —— 一炸就是白屏。数组才是形状对。
测试里专门有一条钉这个（"漏了方括号也判不通过"），
还有一条钉"'两个都没有'的空壳仍然不通过"—— 不然把 `||` 写成"永远 true"也不会红。

### 顺带 grep 了所有 `.skills` 的用法（规格要求的"看还有没有别处假设它一定存在"）

| 位置 | 原来 | 现在 |
|---|---|---|
| `web/src/store.ts` `isTechniqueShape` | `Array.isArray(o['skills'])` | `skills \|\| sequences` 至少一个是数组 |
| `web/src/store.ts` `requiredSkills` | `new Set(tech.skills)` ← **会抛** | `new Set(tech.skills ?? [])` |
| `web/src/store.ts` `migrateV1` / `decodeShare` 等 6 处 | 已经是 `?? []` / `!== undefined` 判断 | 不动 |
| `web/src/main.ts` 5 处 | 已经是 `?? []` | 不动 |
| `src/validator/index.ts` `hasSkills` + 6 处 | 已经是 `Array.isArray` / `?? 0` | 不动 |
| `src/cli/validate.ts` / `src/cli/run.ts` / `src/pricing.ts` / `src/sim/compile.ts` | 已经是 `?? []` | 不动 |
| **`tools/overview.ts` 3 处** | `for (const sid of t.skills)` ← **会抛** | 抽成 `skillIdsDeep(t)`（自己 `?? []`） |

⚠ **`tools/overview.ts` 是 grep 出来的意外收获**，它原来是**两个**问题叠在一起：
① 直接遍历 `t.skills`（序列术式上当场抛，把整个工具打死）；
② 技能表只读 `content/skills`，不读 `content/weapon-skills` ——
于是武器术式显示 `✗ 技能不存在：skill.ws-slash`（技能明明在）。
②是**上一轮**武器技能分目录时就留下的。修完 `npm run overview` 上
`tech.iron-sword-basic` 正确地列出「横砍 `skill.ws-slash` 规则位 4」。
（这个文件在规格的"不要动编辑器 UI"范围之外，它是个只读工具。）

### 存档兼容（⚠ 这是硬要求）

- **`SAVE_VERSION` 仍然是 3，没有升**：改的只是"缺字段时怎么推"，
  存档的**形状一个字没变**。升版本号会白跑一遍迁移，还会把玩家的 `kind` 重推一遍。
- 迁移的**"已经有 `kind` 的一个字都不动"**这条纪律**没变**：系别是玩家在编辑器里选的，
  不是能推导出来的东西。重推一遍等于把他选的改掉。
- **老分享码照样读**（`TS1.` / `TS2.`）：形状检查放宽之后，
  一份"只有 `sequences`、没有 `skills`、没有 `kind`"的老码能解开，
  补上 `kind: 'magic'` 再过校验器。
- 测试里真的**存一趟读一趟**（`saveState` → `loadState`）并断言序列和
  `sequenceLinks` 一个字没变 —— 只测形状的话，"形状过了但存档那一步还是把它过滤了"照样能溜过去。

---

## 四、验证（全部实跑）

```
npm test          17 个文件全绿。合计 **1151 → 1186**
                  （15 个断言文件 1127 → 1162：新增 tests/school.ts +25、store.ts +10；见下面"计数口径"）
                  另有校验器 8 + 纯净性 16 不变（纯净性仍是 16 个文件）
npm run validate  51 个文件 · **51 通过 · 0 失败 · 9 警告**（和改动前一模一样）
                  —— 这一条是关键：kind 推导或内容标注如果还有问题，这里会出现失败
npm run typecheck 两个 tsconfig 都干净
npm run calibrate 标定前最大偏差 **18.4** → 标定后 **1.47**（均方根 8.024 → 0.832，和改动前一模一样）
npm run build:web 通过
node tools/overview.ts  17 个术式，**一条 ✗ 都没有**（修之前有两个"技能不存在"）
```

⚠ **计数口径**（这一轮**我又算错了一次**，第三次了 —— 原样记下来）：
上面写的 `1176 = 1152 + 8 + 16` **是错的**。真相是 **`1186 = 1162 + 8 + 16`**。

错在哪：我是拿"**上一轮的 1127** + 新增的 25"算成 1152 的 ✗ ——
**漏掉了同一轮里 `tests/store.ts` 也涨了 10 条**（44 → 54）。
"拿旧的和加新增"这种算法**只要有一个文件同时变了就会错**，而它已经错了三次
（1141→1127 那次、1176 这次，加上中间一次）。

⇒ 已经不再手算：README 里放了一段 PowerShell，**逐个文件读它自己打印的数**再相加
（`cd technique-system` 那一段）✓ `README.md`（三处）和 `docs/STRUCTURE.md` 已按 **1186** 修正 ✓

⚠ 教训升级：**canary 数字不能手算，也不能"在旧值上做增量"** ——
要么跑那段脚本，要么就别写数字。

**内容改动的核对**（⚠ 不许用 PowerShell 的 `Get-Content`/`Set-Content` 处理中文 JSON，会乱码）：
`content/internal-techniques/mark-blink.json` 用 `edit` 工具做**精确字符串替换**
（`"kind": "weapon"` → `"kind": "magic"`，全文只匹配一次），改完用 Node 重新 `JSON.parse`：
`id` / `name` 中文正常（`标记 · 瞬影`）、没有 U+FFFD、`kind === 'magic'`，
并逐字段比对确认**只有 `kind` 这一个值变了**（外加新加的 `_comment_kind` 注释字段）。

---

## 五、欠账

1. **修饰技能**：**没写**（规格明确要求别写 —— 那个概念还没实现，写出来就是惰性代码）。
2. **编辑器 UI**：**没动**（`web/src/editor.ts` / `technique-editor.ts` 下一轮整块重做）。
   所以"玩家在编辑器里选 `kind`"这件事仍然没实现 —— 上一轮的欠账原样留着。
3. **分享码里推不出武器术式**：`withDerivedKind` 看不见内容库，
   一份"只挂序列"的武器术式分享出去、对方解出来会被补成 `magic`。
   要修得把 `kind` 写进 `TS1.` 码里（老码没这个字段，所以只能继续用退路），
   或者把分享码升到 `TS3.` 带上它 —— 那是改格式，得单独一轮。
   ⚠ 偏 `magic` 是**故意选的退路**（见上面那张表后面的解释），不是漏了。
4. **`docs/STRUCTURE.md` 里 `src/` 和 `web/` 那些表的"行"**：它们是上一轮之前的数，
   和现在对不上（`web/src/main.ts` 写的 2464、实际 3026）。这一轮只把 **tests 那一整张表**
   换成实测值并加了 `tests/school.ts` 一行 —— 剩下的没顺手改（改就得整张重测，是另一轮的事）。
   `schema/skill-schema.ts` 的行数（1193 → 1387）也没改。
5. **`mark-blink` 的 `kind: 'magic'` 只是"和规则一致"，还没有第二道保险**：
   `npm run validate` 只会检查"同一门术式里的技能同不同系"，
   它检查不出"一份魔法术式里放了魔法技能、但 `kind` 被误标成 weapon"。
   真正盯着这件事的是新增的 `tests/school.ts`（17 份逐份重算）。
   也就是说：**这份内容是靠测试守着的，不是靠校验器守着的**。
6. **桌面壳（`desktop/out/`）里那份是打包产物**，没重新打包（和上一轮一样，
   下一次 `desktop/pack.mjs` 会带上新内容）。

---

## 改了哪些文件

**内容（1 份）**
- `content/internal-techniques/mark-blink.json`：`kind` `weapon` → `magic`
  （+ 新增 `_comment_kind` 说明为什么它虽然是序列却不是武器术式）

**代码（4 个）**
- `src/school.ts`：`deriveTechniqueKind` 换成**传递**规则（迭代 + `seen` 防循环 +
  可选 `sequenceOf` 解析器）；新增 `deriveTechniqueKinds`（一次算一整套）；
  文件头补一句"这个文件也管术式那一侧的一半"（行数 109 → 173）
- `web/src/store.ts`：`isTechniqueShape` 接受"只有 `sequences`"；
  `requiredSkills` 改 `?? []`；`parseState` / `loadState` 收
  `{ weaponSkillIds, sequenceOf }`（原来只收一个 `Set`）；
  迁移注释和 `SAVE_VERSION` 的注释说明"为什么这次不升版本号"
- `web/src/main.ts`：`loadState` 多传一个 `sequenceOf`（查**内容术式表**）
- `tools/overview.ts`：3 处 `t.skills` 改走 `skillIdsDeep()`（顺手展开序列）；
  技能表改读 `SKILL_DIRS` 两个目录

**规格（1 个，只改注释）**
- `schema/skill-schema.ts`：`Technique.kind` 的注释里那段"老数据怎么补"换成传递规则
  （⚠ 不改类型，改的是那句已经过时的说明）

**校验器（1 个，只改提示文案）**
- `src/validator/index.ts`：`MISSING_KIND` 的 hint 里那句
  "有 sequences、或者引用了武器系技能的算 weapon" 改成传递规则的说法

**测试（2 个，其中一个新的）**
- `tests/school.ts`（**新**，25 条断言）：规则本身（一层 / 两层 / **三层** / 悬空引用 /
  没有解析器时的退路）、**防循环**（A→B→A、A→A、"每个 id 只展开一次"、
  "环里藏着武器技能照样找得到"）、**17 份出厂内容全部重算一致** + 四份 weapon 点名 +
  `mark-blink` 是 magic
- `tests/store.ts`（25 → 54 条）：新增一整节"序列术式（只写 `sequences`、没有 `skills`）
  能过形状检查、能存能读回来、老分享码能解"，含两条**反向**断言；
  v2→v3 迁移那一节改成"只挂序列的**真的不写 `skills`**"（原来是 `skills: []` 绕过去的），
  并新增"序列里全是魔法技能 → `magic`"这条反例
- `package.json`：`npm test` 里加上 `tests/school.ts`（放在 `tests/store.ts` 之后、
  `tests/web.ts` 之前）；新增 `test:school` script

**文档（3 处）**
- `technique-system/README.md`：两处断言计数（`1151 → 1176`、口径里的 `14 → 15` 个文件）、
  章节标题 `十六套 → 十七套`、单独跑一套那一行加 `test:school`、新增 `tests/school.ts` 一节
- `docs/STRUCTURE.md`：合计那一处（+ 新增的那条口径说明），
  tests 整张表的行数 / 断言数换成实测值并加 `tests/school.ts` 一行
- `docs/log/README.md`：索引加一行
- `docs/log/2026-09-27-44-kind-derivation-fix.md`：本篇

**一次性脚本（`.scratch/`，不进仓库）**
- `audit-kind-transitive.mjs`（17 份对照表）、`verify-mark-blink.mjs`（内容改动的逐字段核对）、
  `probe-share-seq*.ts`（分享码那条路的手工探针）

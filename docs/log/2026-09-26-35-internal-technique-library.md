# 术式分成两个库 + 删掉出厂示范术式 + 开局那份变成玩家自己的

- **日期**：2026-09-21
- **触发**：承接日志 34 的第二件事（"初始只有一个术式释放某个技能，现有技能库不改，
  玩家可以自行创造术式"）—— 玩家验收时连着问了两个问题：

  > 编辑器里术式那栏为什么有出场示范？而没有应该有的那个魔法飞弹术式？

  > 为什么非要有那么多示范术式？不是有基础技能和起始术式了吗

  以及他给出的两条决定（我问了他才定的）：

  > 敌人用的术式存到别的地方，玩家在编辑器里看不到这些示范术式，也没法引用它们。

  > 初始只有一个术式释放某个技能。

- **动了哪些文件**
  - 内容：`content/techniques/`（35 份）**拆开** → `content/internal-techniques/`（17 份，留下真的被引用的）；
    删掉 18 份示范；`content/manifest.json`（`techniques` → **`internalTechniques`**）；
    `content/scenarios/arena.json`（注释全部重写 —— 它们描述的是已经不存在的 10 格技能栏）
  - 加载：`src/bridge.ts`（目录名）、`web/src/main.ts`（清单键 + 路径 + **`seedStarter`**）
  - 编辑器：`web/src/technique-editor.ts`（**只列「我做的」**，删掉「出厂示范（只读）」分组和「复制成我的」）
  - 存档：`web/src/store.ts`（`SavedState.seeded`）
  - 工具：`src/cli/validate.ts`、`src/cli/run.ts`、`tools/overview.ts`（目录名 + 例子换成还活着的文件）
  - 测试：`tests/probes.ts`（**新**：探针术式）、`tests/{scenario,battle,blink,smoke,web}.ts`
  - 文档：`README.md`、`docs/STRUCTURE.md`、`docs/glossary.md`、`docs/skill-ideas.md`

---

## 一、玩家看不见的术式，存到别的地方去

上一轮把技能栏改成"开局一格"之后，术式编辑器里仍然列着一个「出厂示范（只读）」分组 ——
三十多份"一个技能配一份同名术式"的东西，外加「复制成我的」按钮。
玩家的反应是：**为什么有出场示范，而没有应该有的那个魔法飞弹？**

两件事他都说对了：

1. **那些示范不该在玩家的创作台里。** 它们是给敌人和武器用的**内部数据**，
   和"玩家能拿什么当起点"是两回事。三十多份同名术式列出来，看起来就是一条技能栏。
2. **开局那一格（`tech.magic-bolt`）没进「我做的」** —— 它是内容，玩家改不了、也删不掉。

他定的解法：

> 敌人用的术式存到别的地方，玩家在编辑器里看不到这些示范术式，也没法引用它们。

于是：

| 以前 | 现在 |
| --- | --- |
| `content/techniques/`（35 份，什么都塞一起） | `content/internal-techniques/`（**17 份**，只留真的被引用的） |
| 清单键 `techniques` | `internalTechniques`（名字就说明它**不是给玩家看的**） |
| 编辑器列「我做的」+「出厂示范（只读）」+ 复制成我的 | 编辑器**只列「我做的」**；那个复制按钮改成「另存为一份」（复制**自己**的术式） |

留下的 17 份的判据是**谁在引用**（`sample-techniques-audit.mjs` 带传递闭包算的）：

- 场景里 AI / 玩家开局用的：`cleave` `magic-bolt` `charged-laser` `frost-lock`
  `curse-of-undead` `soul-rend` `hunt` `stealth` `slow-field` `blood-pact`
- 武器术式引用的序列：`ws-slash` `ws-thrust`（← `longsword-basic` 用）`iron-sword-basic`
- 二段技能那三份：`mark-step` → `blink-step`，容器 `mark-blink`

删掉的 18 份：`aegis` `armor-pierce` `barrier` `blood-offering` `charge-and-slash`
`charge-impact` `charm` `flame-wall` `holy-light` `hunter-instinct` `infinity`
`insight` `iron-shirt` `last-stand` `lava-armor` `named-blade` `place-slow-field` `raise-dead`。

⚠ **技能一个都没删**：基础技能库还是 30 个。所以玩家想拼火墙、召唤、冲撞冲击、
名刀司命，全都能自己拼出来 —— 这正是"术式是玩家创造的"。

## 二、那一份"起手"必须变成玩家自己的

光把示范藏起来还不够 —— 玩家的库里得**有东西可改**，而且得是**他的**。

所以开局那一刻（`seedStarter`）：

```
场景里写 techniques: ["tech.magic-bolt"]      ← 内部术式（敌人的骷髅术士也在用）
        ↓ 第一次打开游戏时复制一份
mine: { id: "tech.mine-1", name: "魔法飞弹（起手）", skills: ["skill.magic-bolt"] }
savedLoadout: ["tech.mine-1"]                ← 技能栏指向副本
```

三个细节都有理由：

- **名字加「（起手）」**：不加的话它和技能**同名** —— 玩家已经抱怨过一次
  "名字和技能一模一样，看起来就是一条技能栏"。加了后缀，列表里一眼能看出
  "这是我的术式，里面装着某个技能"。
- **复制完必须 `recompileAll()`**：引擎认的是编译产物。不编译的话 `restart()` 里
  `library.has(副本 id)` 是 false，技能栏会**静默退回**场景默认那一份 ——
  玩家会觉得"我做的术式进不了场"。
- **厂注释（`_comment*`）不跟着进玩家的术式**：它会出现在导出 JSON 和分享码里。

⚠ 只发**一次**，靠 `SavedState.starterId` 落盘 —— 它存的是**那个 id**，不是 true/false：

```
没发过（undefined）       → 发一份
发过、还在库里             → 什么都不做（他可能已经改过名字/内容）
发过、不在库里 = 他自己删的 → 不许再发（不然像是删不掉）
```

### ⚠ 这一段第一版写错了，玩家一句话打回来

第一版是 `seeded: boolean`，而且"存档里已经有术式 **或** 排过技能栏"就算"不用发"。

玩家打开游戏只回了一句：

> 并没有魔法飞弹

他对。那个判断把两种人挡在门外：

1. **技能栏里只剩场景发的内部术式**的老存档（`loadout: ['tech.magic-bolt']`）——
   那一格玩家在编辑器里**看不到也改不了**（术式编辑器只列「我做的」），
   却被当成"他已经有自己的东西了"，于是永远拿不到那份能改的起点。
2. 已经有自己术式、但就是想要那份起手的人。

改对之后的规则只有一条：**没发过就发**（不管他有没有别的术式），
但**技能栏只在"里面没有他自己的术式"时才动** ——
空的、或者只剩看不见的内部术式，都算没排过：清掉那几格，把起点装到第一格。
排过他自己的东西（哪怕只有一格）就一格都不碰。

顺带两处：

- `ensureMine()` 默认选中**技能栏上装着的那一份**（以前是"id 排序第一个"）——
  补发起点之后，排序第一个变成了那份起手，而玩家自己排上场的那份反而要手点一下。
- `seedStarter` 整段包进 `try`：发起点是锦上添花，它出问题不该把
  "没有魔法飞弹"变成"整个页面白屏"。另外往 console 写一行
  `[开局术式] 发了 …` / `… 已经被删过，不再补发`，下次再出这种事一眼就能看出来。

对应的测试（`tests/web.ts`）现在钉着四种存档形态：没有存档 / 老存档带自己的术式
（补发起点但技能栏不动）/ 技能栏只剩内部术式（补发并换掉那一格）/
`starterId` 指向一份已删的术式（不再补发）。

## 三、测试不能和"出厂有几份示范"绑死

那 18 份被删的术式里，有十几份是测试的夹具（护盾吸收、冻结禁用、被动 onCast、
prevHit 连接……）。这些测的是**引擎行为**，和出厂有几份示范无关。

所以加了 `tests/probes.ts`：把用到的那几份**现造**出来（形状照抄，
`activation` / `targeting` 都对 —— 被动是 `auto`、常驻开关是 `toggle`，
抄错了 `setTechniqueActive` 的行为会变），`lookup` 变成"出厂内容优先，其次探针"。

⚠ 它**不是**测试用例，是一个夹具模块 —— 加进 `npm test` 的文件列表会报"没有断言"。

## 四、顺手清掉的一堆过时文字

- `arena.json` 的注释全在描述**旧的 10 格技能栏**（键 3 冲撞冲击、键 4 火墙、键 9 召唤…）——
  全部重写成现在的样子（只有键 1，其余等玩家自己拼；那几种能力都能自己拼出来）
- README 里"`content/techniques/` 下八个术式"那张表：七个文件已经不存在了，
  换成内部库现在这 17 份里值得讲的几张
- README / STRUCTURE 里那 18 处**每套测试多少断言**：从 2026-09-20 起就没跟上过
  （pricing 写 36 实际 92、web 写 4 实际 38）。**删掉**，只留总数 —— 抄下来的数字
  要改七个地方，最后谁都不信它
- `content/techniques/charge-and-slash.json` 那个"两层模型"的例子：那是唯一一个
  "两个技能接起来"的内容，删了之后内容里没有这种例子了 —— 例子改成玩家在编辑器里的形状

---

## 验证

| 检查 | 结果 |
| --- | --- |
| `npm test` | 16 个文件全绿 · **1095 个断言**（16 个文件 + `probes.ts` 夹具） |
| `npm run validate` | **51 个文件** · 51 通过 · 0 失败 · 9 警告（少掉的 18 个是删掉的示范） |
| `npm run typecheck` | 两个 tsconfig 都干净 |
| `npm test` 里的清单检查 | `content/internal-techniques` 和 `manifest.internalTechniques` 对得上（17 个） |
| `npm run build:web` + 浏览器 | 页面 200；「我做的」里是「魔法飞弹（起手）」，技能栏第一格指着它 |

⚠ 老存档的路径现在**有测试**了（`tests/web.ts` 四种存档形态），但真机上
"浏览器里那份 localStorage 长什么样"还是只有你能看到 —— 如果刷新之后
「我做的」里仍然不是「魔法飞弹（起手）」，按 F12 看 console 里那行
`[开局术式] …`，把那句话发我。

## 欠账

- **二段技能那三份留在内部库了**（`mark-step` / `blink-step` / `mark-blink`）。
  它严格来说也算"示范"，但它是**这一整块引擎能力（二段 / 容器序列 / 条件门 /
  `requireStatusTag`）唯一的内容实例**，`tests/blink.ts` 端到端跑的就是它。
  这是这一轮我**自己拿的一次主意**：要删也行，说一声，我把那三份挪进 `tests/fixtures/`，
  测试改成自己编译。
- `content/manifest.json` 的键改名了（`techniques` → `internalTechniques`），
  **老的分支/脚本如果还在读 `manifest.techniques` 会读不到** —— 这一轮没做兼容分支。
- 之前几轮的欠账还在（见日志 34）：技能修正、修饰技能、锚点表、阶段时长档位、
  血祭斩/裂魂的过时标签。

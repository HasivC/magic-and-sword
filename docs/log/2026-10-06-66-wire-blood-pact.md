# 血契**接线**：`bloodPactCostOf` 改读三段式表（表算的 = 引擎扣的）

- **日期**：2026-10-06（机器时钟核对过：`2026-10-06`）
- **触发**：**用户**当轮下令 —— 把日志 65 算出来的那张三段式表**接上线**。
  日志 65 是"**只算不接线**"：`PriceResult.threeSection` 有了，而**引擎扣费没读它**
  ⇒ 实测反例：**纯常驻 + 多重释放 ×10 ⇒ 表说血契 0、引擎说 18**（**多收**）。
- **动了哪些文件**（4 个，`src/sim/**` **一个字节没动**）：
  - `technique-system/src/pricing.ts`（`bloodPactOfResult` 新增 + `bloodPactCostOf` 改读表
    + `PriceEntry.half` 新增 + 切分改成从 `half` 加出来）
  - `technique-system/src/validator/index.ts`（`CONSTANT_SIDE_NEGATIVE` 警告 → **错误**；
    `bloodPactPerUse` 和 `NEGATIVE_TECHNIQUE` 文案改读**同一个函数**）
  - `technique-system/src/validator/types.ts`（`bloodPactPerUse` 的口径注解）
  - `technique-system/tests/pricing.ts`（改 1 条 + 拆 1 条 + 新增 10 条）

---

## 改了什么

### 一、⭐ 接线那一处（本片的核心）

**判据只有一处**：`src/pricing.ts:864` 的

```ts
export function bloodPactOfResult(priced: PriceResult): number {
  return priced.threeSection?.bloodPact ?? 0
}
```

`bloodPactCostOf`（`src/pricing.ts:841`）改成 `return bloodPactOfResult(priceTechnique(...))`。
引擎那条链一个字都没改，改的只是**那个数的来源**：

```
bloodPactCostOf（pricing.ts:846）→ CompileOptions.bloodPactCost（compile.ts:754）
  → CompiledTechnique.bloodPactCost → cast.ts 的 canActivate / activate（扣费）
```

`?? 0` 那支**不是**"读不到就退回老口径"：`threeSection === undefined` 只有一种来源 ——
`priceTechnique` 判"这门术式**不算账**"（武器术式）⇒ 没有点数 ⇒ 没有血契。
**老口径 `|合计|` 一个字都不许退回去**，那正是本片修掉的那个 bug。

**反例改前改后**（探针实测，`D:\dsh works\.wire66\probe66.ts` 的输出）：

| 形状 | 主动那半 | 常驻那半 | 表（`threeSection.bloodPact`） | 引擎（改前 = 老口径） | 引擎（改后） |
| --- | --- | --- | --- | --- | --- |
| ⚠ **反例：纯常驻 + 多重释放 ×10** | 0 | **−18** | **0**（不能吃 ✗） | **18**（**多收 18**） | **0** ✓ |
| 混合（主动：多重 ×10 / 常驻：等待 3 秒） | **−18** | **+2** | **18** | **16**（`|−16|`，**少收 2**） | **18** ✓ |
| 混合 + 常驻那半为负（主动：等待 3 秒 / 常驻：多重 ×10） | +2 | **−18** | **0** | **16**（**多收 16**） | **0** ✓ |
| 纯主动（多重 ×10） | **−18** | 0 | 18 | 18 | 18（没变） |
| 纯常驻为正（等待 3 秒） | 0 | **+2** | 0 | 0 | 0（没变） |
| 武器术式（不算账） | — | — | 没有切分 | 0 | **0** ✓（`?? 0` 那一支） |

**三个读者现在是同一个数**（这也是加 `bloodPactOfResult` 这个函数的理由）：

| 读者 | 改前 | 改后 |
| --- | --- | --- |
| 引擎（`CompiledTechnique.bloodPactCost` → `cast.ts` 扣费） | `kind==='negative' ? |total| : 0` | `bloodPactOfResult` |
| 校验器报告 `ValidationReport.bloodPactPerUse`（`validator/index.ts:2116`） | 同上 | 同上 |
| `NEGATIVE_TECHNIQUE` 警告文案里印的那个数（`index.ts:2033`） | `Math.abs(total)` | `bloodPactUse`（同一个数） |

⚠ **`kind` / `total` 一个字都没变** —— `negative` 那个判据说的是"这门术式能不能白用"
（玩家原话"**合计为负才是负值术式**"），它**不是**"扣多少血契"；扣多少由**主动那半**说了算。
两件事今天各有各的入口，都在 `priceTechnique` 的同一本账里。

### 二、⚠ 混合术式里"常驻那半为负"：**警告 → 错误**

落点是 `src/validator/index.ts:2073`：`warn('CONSTANT_SIDE_NEGATIVE', …)` → `err(…)`。
理由照用户裁定：定稿那句"**常驻那半边必须自己 ≥ 0**"是**一条硬约束**，
⇒ **同一条约束不该两种档**（纯常驻报错、混合只警告 = 两种档）。

⚠ 日志 65 选告警的理由是"该情形今天**构造不出来**" —— **那个理由是错的**：
`activation: "press"` + 常驻段 + 主动段**能编译、能过校验**
（`WRAP_IN_NON_PRESS_TECHNIQUE` 只管"非 press"），
本片探针实测它 `fatal=true`（改后），所以混合为负**真能构造**。

⚠ 两条 code 仍然分开（`CONSTANT_ONLY_NEGATIVE` / `CONSTANT_SIDE_NEGATIVE`），
因为**措辞**不同（"只有常驻序列" / "两种都有"）；**判据仍然只有这一处 `if`**。
`allSequencesAreConstant` 那句函数今天**只决定措辞、不决定级别**（它的注释跟着改了）。

### 三、⚠ 账能说出"这一笔在哪一半"（`PriceEntry.half`）

`src/pricing.ts:650` 新增 `half?: 'active' | 'passive'`（可选，只有 `priceTechnique` 会填 ——
和 `skillId` 同一条规矩）。填法：

| 明细来源 | 落在哪一半 | 判据 |
| --- | --- | --- |
| `tech.skills` 那一条条技能账（`pricing.ts:3340`） | **主动** | 技能挂在**术式那一层** ⇒ 玩家按那个键才走到它们 |
| 段上的修饰副本（`pricing.ts:3365`） | 认得出段号且那一段被包装 ⇒ **常驻**，否则 **主动** | `segmentIndexOfEntryPath` + `constantFlags`（= `isConstantSequence`，**同一句**） |

⚠⚠ **两半的和就是从这一栏加出来的**（`pricing.ts:3394`）：原来另有一份"哪些下标是常驻"的
`Set`，和条目分头走；现在**只有 `half` 一处** ⇒ 汇总和界面**不可能不一致**。
整数化（`integerizeEntries`）原样带着这个字段，所以下标对齐那类隐患一并消失。
**本片只加数据**：`web/src/**` **一个字节没动**（界面那片要用它，那是下一片）。

### 四、用户已定的口径（逐条照做，没有重定）

1. **血契 = `max(0, −主动序列的点数和)`**（裁定 A）✓ —— 就是 `threeSection.bloodPact`。
2. **常驻那半的正额度不补贴主动** ✓ —— (A) 在：混合那门 18 而不是 16。
3. **主动那半为正 ⇒ 不报** ✓（定稿说"可以按警告处理，也可以只提示不报警"）⇒ 留口子。
4. **"只有常驻技能、没有序列"的术式按主动算** ✓（维持日志 65 的判断：引擎里全常驻术式是用
   **包装**表达的 ⇒ **模型与引擎待对齐**，仍列在待裁定里）。
5. **空术式照旧先报 `EMPTY_TECHNIQUE`** ✓（`priceable` 为假 ⇒ 拿不到 `threeSection`，路径没动）。

---

## 为什么

- **"同一个数"必须是构造出来的，不能靠自觉**。日志 65 的教训是：表和引擎**分头算**，
  于是同一个形状有两个数，而且**两边都不报错**（"表说 0、引擎说 18"）。
  本片的做法是把那个数收成**一个函数**（`bloodPactOfResult`），三个读者共用。
- **`half` 记在明细自己身上**而不是旁边另开一份名单：界面要读的就是明细上那个字段，
  两份东西分头走一定漂移（漂移的症状正是本片修的那类："界面按 A 显示、引擎按 B 扣"）。
- **同一条约束不该两种档**：档位（错误 / 警告）是给玩家的信号强度，
  按"好不好构造"来定档，等于让**当时写代码的人有没有想到某个形状**决定内容合不合法。

---

## 验证（真实输出）

| 项目 | 结果 |
| --- | --- |
| `npm test` | **17 个文件全绿**；15 个断言文件 **1972 → 1982**（**只有 `pricing` 272 → 282，+10**），加校验器 11 用例 + 纯净性 18 文件 ⇒ 合计 **2001 → 2011** |
| `npm run validate` | **57 个文件 · 57 通过 · 0 失败 · 9 警告**，输出与改前**逐行完全相同**（1266 行 / 1266 行，`Compare-Object` 空） |
| `npm run typecheck` | 无输出、exit 0 |
| `npm run build:web` | 无输出、exit 0（`web/dist` 已重建；用户在 `127.0.0.1:5173` 刷新即可，**没有重启服务**） |
| `battle` 12 秒 | **`44C782A4984C3922A728786E9A63B9BC2396D5DCED1570FDE19C93CD942998B1`** = 基线逐位相同；**1989 字节（非空）**；逐行比对空 |
| ⭐ 出厂全 0 | `tests/pricing.ts` ⓐ **32 个技能**（账逐条整数 / 非零 ≥1 / 各条之和 = 合计）+ ⓑ **14 份出厂术式：合计与条目数都是 0** —— 两条常驻断言**照旧绿** |
| 纯净性 | `src/sim/**` **18 个文件逐字节相同**（哈希对照 `.wire66/wire66-before/src/sim`）；`tests/purity.ts` 过 |
| 探针 | 放在**项目外** `D:\dsh works\.wire66\`（`probe66.ts` / `probe66-out.txt`）；`web/dist` 里**零个** probe 产物（grep 空） |
| `calibrate` | **没重跑对照**：它只 import `DEFAULT_RATES, priceSkill`（`tools/calibrate.ts:41`），全 `tools/*` 里 **0 处**引用 `entries` / `threeSection` / `bloodPact` ⇒ 结构上碰不到本片；单独跑一次 exit=1 是它**自己的**残差信号（`calibrate.ts:441` 的 `return stuck ? 1 : 0`） |

**改了哪几个文件**（哈希对照整棵 `src` / `tests`）：

```
src/pricing.ts · src/validator/index.ts · src/validator/types.ts · tests/pricing.ts
（其余 18 个 sim 文件 + 全部 web/src + content/** 一个字节没动）
```

---

## 逐条点名的断言改动（`tests/pricing.ts`）

**改的（2 条）**：

1. `ok('混合术式 + 常驻那半为负 ⇒ 只**警告** CONSTANT_SIDE_NEGATIVE（不是错误）')`
   → **`⇒ 错误 CONSTANT_SIDE_NEGATIVE（和纯常驻同一个档）`**：判据从 `level === 'warning'`
   改 `'error'`。⚠ 这就是"②那条从警告升错误"的落点断言。
2. `ok('⚠ 待裁定：threeSection.bloodPact = 0 …而引擎读的那个数还是 |合计| = 18 —— 两个数今天不一致')`
   → **删掉**，由下面 ⑨ 那三条取代（它钉的是"坏掉的现状"，留着会挡住本片的目标）。

**留着的（1 条，只有注释变了）**：

3. `这一门同时拿到 CONSTANT_ONLY_NEGATIVE（错误）和 NEGATIVE_TECHNIQUE（老警告）` ——
   断言本体一个字没改（**两条仍然并存**），但注释里"这正是两个数不一致的表现"那段删了：
   今天它们说的是两件不同的事（常驻那半必须 ≥ 0 / 整本账为负），
   而**血契那个数已经是 0** ⇒ 那条老警告会说"消耗 0 点血契"（见待裁定 1）。

**新增的（10 条，⑨ 接线 + ⑩ `half`）**：

4. ⭐⭐ **反例消失**：纯常驻 + 多重 ×10 ⇒ **表 0、引擎 0**（改前表 0、引擎 **18**）
5. **校验器报告里那个数**也是 0（`bloodPactPerUse` 和引擎读同一处）
6. 那个数**真的进了编译产物**：`compileTechnique(…).compiled.bloodPactCost === 0`
7. ⭐ **混合**（主动 −18 / 常驻 +2）⇒ **表 18、引擎 18**（老口径按 `|−16|` 收 16 ⇒ 少收 2）
8. 纯主动 ⇒ 18、纯常驻为正 ⇒ 0（这两种形状本来就没变）
9. **武器术式**（不算账）⇒ 引擎 0（`?? 0` 那一支，**不许**退回 `|合计|`）
10. ⭐ **主动那半为正 ⇒ 一条 `CONSTANT_*` 都不报**（用户裁定：这一格留口子）
11. 术式账**每一条**都带着 `half`（不许有洞）
12. ⭐ **两半的和就是按 `half` 加出来的**（和 `threeSection` 逐位相同）
13. 没被包装的段 ⇒ 整本账落进**主动**那半（安全方向）
14. **技能自己的账**没有 `half`、也没有 `threeSection`（没有"哪一段"这回事）

⚠ 只有 `pricing` 一个文件的数动了（272 → **282**），其余 14 个断言文件**一个数都没变**。

---

## 待裁定（**6 条**，一条都没有自己定）

1. ⚠ **`NEGATIVE_TECHNIQUE` 在"血契为 0"时还要不要报**：纯常驻为负那一门，今天
   报告里同时有 `错误 CONSTANT_ONLY_NEGATIVE` 和 `警告 NEGATIVE_TECHNIQUE`，
   而后者印的是"合计 −18，**每次释放消耗 0 点血契**"。
   ⚠ 本片**只改了那个数**（它必须和引擎同一个数），**没有动条件**（`kind === 'negative'`）——
   要不要在 `bloodPactUse > 0` 时才报，是一句话的事（`index.ts:2030` 那个 `if`），
   但那会**删掉一条现有的警告**，所以停下。
   同一个问题也落在 `cli/validate.ts:117`（那一行印 `r.bloodPactPerUse`）。
2. ⚠ **`CONSTANT_SIDE_NEGATIVE` 这个 code 要不要合并进 `CONSTANT_ONLY_NEGATIVE`**：
   今天两条 code 一个级别（错误）、只有措辞不同（"只有常驻序列" / "两种都有"）。
   本片保留两条（code 能分辨形状），要合并是**一个字符串**的事。
3. ⚠ **"只有常驻技能、没有序列"的术式**：仍然按**主动**算（日志 65 的判断 + 用户裁定的口径 4）。
   ⚠ **模型与引擎待对齐**：定稿说全常驻术式 ≈ 常驻那半，而引擎里它是 `activation: "auto"` +
   一堆技能，账上全落主动 ⇒ 它的血契是 `|合计|` 而不是 0。要不要把"auto 术式的技能那半"
   也判成常驻，会影响 `tech.blood-pact` 之外**所有常驻术式**的扣费。
4. **空术式**的账卡显示什么（`priceable` 为假 ⇒ 没有 `threeSection`）：路径没动，仍然由
   `EMPTY_TECHNIQUE` 管着。
5. **`PriceEntry.half` 什么时候进界面**：本片**只加数据**（`web/src/**` 一个字节没动）。
   要在账卡上按"主动 / 常驻"分两栏，是下一片 UI 的事；`half` 已经在每一条明细上。
6. **`threeSection` 缺席时要不要在报告里说出来**：今天"不算账"由 `priceless` 那句话管着，
   而血契那一栏就静默是 0 —— 这两种 0（"算过、刚好 0" / "根本不算账"）今天在
   `bloodPactPerUse` 上看不出区别（合计都是 0）。要不要分开，待裁。

---

## 没做的事

- **`web/src/**` 一个字节没动**（`half` 只是数据；界面上今天看不到主动 / 常驻的分栏）。
- **`NEGATIVE_TECHNIQUE` 的触发条件没动**（见待裁定 1）—— 只改了它印的数。
- **`docs/sequence-and-modifier-model.md` 第十二节没有重读改写**（本片是接线，不改规格）。
- **"auto 术式的技能算哪一半"没有改**（见待裁定 3：那会改**所有**常驻术式的扣费）。
- **没有动 `src/sim/**` 的任何判据**：`cast.ts` 照旧只认 `CompiledTechnique.bloodPactCost`
  一个数字（改的是**谁给它**，不是它怎么扣）。
- **`calibrate` 没有重跑对照**（理由见验证表：它结构上碰不到本片）。

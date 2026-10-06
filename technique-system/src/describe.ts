/**
 * 把规则、状态、数值说成人话 —— **从数据生成，不是一个手写的字符串**。
 *
 * ## 为什么必须有这个文件
 *
 * 第一版把说明**手写**在 `Rule.note` 上：
 *
 *     "note": "命中时回复 8 点生命"
 *
 * 然后玩家在编辑器里把 8 拖成 20 —— **说明还是"回复 8 点生命"。**
 * 这跟"点数手写在 JSON 上"是同一个错误：**两份会漂移的东西。**
 *
 * 所以现在的规矩和点数一样：
 *
 *   **说明是内容的函数。你改数值，说明自己跟着变。**
 *
 * ## 那 `note` 还要不要
 *
 * 要，但它只写**设计意图**，不写数字：
 *
 *     "note": "先蓄一发飞弹逼走位"      ← 生成不出来的东西，留着
 *     "note": "命中时回复 8 点生命"      ← 生成得出来，删掉
 *
 * 校验器会报警（`NOTE_WITH_NUMBER`）—— 手写的数字迟早会和数值脱节。
 *
 * ## 这个文件不依赖任何运行环境
 *
 * 命令行（`run.ts`）和浏览器（编辑器）都 import 它，所以它只能是**纯函数**。
 */
import type {
  Action, AttributePayload, Condition, DeliverySpec, Payload, Rule, StatusDef, TriggerEvent, ValueSpec,
} from './schema.ts'

// ============================================================================
//  数值
// ============================================================================

/** 抹掉浮点毛刺。60 次 1/60 加起来是 3.0000000000000004，不该给玩家看这个 */
function num(n: number): string {
  const r = Math.round(n * 100) / 100
  return Number.isInteger(r) ? String(r) : String(r)
}

/**
 * 把 id 翻成人话的两个查表函数。
 *
 * ⚠ 为什么需要它：`statusId: "status.shield"`、`entityId: "entity.skeleton"`
 *   这类字段**存的是 id**（唯一、稳定、能改名字不破坏引用）。
 *   而玩家要看的是名字（护盾 / 骷髅）。
 *
 *   早先的说明里直接把 id 打出来 —— 玩家看到的是
 *   「挂上「status.shield」」「生成 entity.skeleton」，
 *   这不是人话，而且**看着像 bug**。查得到名字就写名字，
 *   查不到（内容里真的没这个东西）就退回 id —— 那时 id 反而是唯一能指认它的东西。
 */
export interface DescribeNames {
  statusName?: (id: string) => string | undefined
  entityName?: (id: string) => string | undefined
}

const NO_NAMES: DescribeNames = {}

function nameOr(names: DescribeNames, id: string, kind: 'status' | 'entity'): string {
  const found = kind === 'status' ? names.statusName?.(id) : names.entityName?.(id)
  return found !== undefined && found !== '' ? found : id
}

/**
 * 一个数值规格怎么说。
 *
 * 常量直接报数字；动态的（引用蓄力量、距离）说明它**跟什么走** ——
 * 把曲线也画出来，因为那条曲线就是"蓄满能打多少"的答案。
 *
 * ⚠ 有曲线的动态参数要说成**范围**（"按蓄力量造成 20~150 点"），
 *   不要写成 `蓄力量（0→20，3→150）` —— 那是给人看的字，
 *   不是让人去读坐标点。曲线本身留在数据里，编辑器有图会画。
 */
export function describeValue(v: ValueSpec | undefined): string {
  if (v === undefined) return '?'

  if (typeof v.const === 'number') return num(v.const)

  if (Array.isArray(v.curve) && v.curve.length > 0) {
    const first = v.curve[0]
    const last = v.curve[v.curve.length - 1]
    const lo = first === undefined ? undefined : first[1]
    const hi = last === undefined ? undefined : last[1]
    if (lo !== undefined && hi !== undefined) {
      return lo === hi ? `${refName(v.ref)} ${num(lo)}` : `${refName(v.ref)} ${num(lo)}~${num(hi)}`
    }
    return refName(v.ref)
  }

  const lo = v.min !== undefined ? num(v.min) : undefined
  const hi = v.max !== undefined ? num(v.max) : undefined
  const range = lo !== undefined && hi !== undefined ? `（${lo}~${hi}）` : ''

  return `${refName(v.ref)}${range}`
}

/**
 * 载体几何里的一个数（`radius` / `length` 可以是动态参数）怎么说。
 *
 * ⚠ 写死数字的招式和以前一字不差（"3 米"）；
 *   写 `ref` 的（武器技能模板）说成"跟武器射程走"——
 *   因为**同一份模板在不同武器上不一样**，这时候报一个数字就是骗人。
 */
function geomText(v: number | ValueSpec | undefined): string | undefined {
  if (v === undefined) return undefined
  if (typeof v === 'number') return num(v)
  return describeValue(v)
}

function refName(ref: string | undefined): string {
  switch (ref) {
    case 'charge': return '蓄力量'
    case 'distance': return '距离'
    case 'selfHpPct': return '自身血量%'
    case 'targetStacks': return '目标层数'
    case 'targetCount': return '目标数量'
    default: return '动态值'
  }
}

// ============================================================================
//  载体
// ============================================================================

/** 载体怎么说。返回的是"打到哪一片" */
export function describeDelivery(d: DeliverySpec | undefined): string {
  if (d === undefined) return ''

  switch (d.kind) {
    case 'self': return '对自己'
    case 'projectile': {
      const bits: string[] = []
      if (d.speed !== undefined) bits.push(`飞 ${num(d.speed)} 米/秒`)
      if (d.lifetime !== undefined) bits.push(`最多飞 ${num(d.lifetime)} 秒`)
      /*
       * ⚠ 这里原来还有一句 `if (d.count …) bits.push(\`${n} 发\`)` —— 2026-09-30 日志 55
       *   跟着 schema 那个死字段一起删掉了（引擎从来没读过 `delivery.count`，
       *   于是描述会写出一个**根本没发生**的"3 发"）。
       *   ⇒ "一次打出好几发"今天只有一条路：修饰零件「一分为 X」。
       */
      if (d.pierce === true) bits.push('穿透')
      /*
       * ⚠⚠ 这里原来还有一句 `if (d.homing === true) bits.push('追踪')` ——
       *   2026-09-30 日志 55（上级裁定）**删掉了**，而日志 56 把整个字段
       *   从 schema 里也删掉了。
       *
       *   为什么它比 `count` 那种死字段更糟：`count` 只是**白写**
       *   （写上去没效果，但也没骗谁）；而这一句是**界面主动承诺一件引擎不做的事** ——
       *   玩家照着"追踪"配了飞弹，打出去发现它**直直地飞**，
       *   然后会以为这是一个 **bug**（他没有任何办法知道那是没实现）。
       *
       *   ⚠ 今天 `DeliverySpec` 里**没有** `homing` 这个字段：描述里只有引擎真的
       *   会做的事（`speed` / `lifetime` / `pierce`），而写 `homing` 的人由**校验器**
       *   接住（`BAD_DELIVERY` 报错，话里指路修饰零件「追踪」）。
       *
       *   ⚠⚠ **「追踪」今天是一个真机制**（日志 56 落地）：它是**修饰零件**
       *   （`content/modifiers/homing.json`，`kind: 'homing'`），
       *   让**被它修饰的投射物**在半路上自己找最近的敌人。
       *   ⚠ 它的说明**不写在这里** —— 这一行是「载体」的描述
       *   （"这一发怎么飞"），而"拐过去"是**那件零件**的事、
       *   由它自己的 `note` 说（`ModifierProto.note`）。
       *   两个不同的东西写在两处，才不会出现"载体说它追踪、而它其实没装零件"。
       */
      return `发射飞弹${bits.length > 0 ? `（${bits.join('，')}）` : ''}`
    }
    case 'beam': {
      const bits: string[] = []
      const len = geomText(d.length)
      if (len !== undefined) bits.push(`${len} 米长`)
      if (d.width !== undefined) bits.push(`${num(d.width)} 米宽`)
      return `光束${bits.length > 0 ? `（${bits.join('，')}）` : ''}`
    }
    case 'meleeArc': {
      const bits: string[] = []
      const r = geomText(d.radius)
      if (r !== undefined) bits.push(`${r} 米`)
      if (d.angle !== undefined) bits.push(`${num(d.angle)}°`)
      return bits.length > 0 ? `近身扇形（${bits.join('，')}）` : '近身扇形'
    }
    case 'capsule': {
      const bits: string[] = []
      const len = geomText(d.length)
      if (len !== undefined) bits.push(`${len} 米长`)
      if (d.width !== undefined) bits.push(`${num(d.width)} 米宽`)
      return `直线突刺${bits.length > 0 ? `（${bits.join('，')}）` : ''}`
    }
    case 'area': {
      const r = geomText(d.radius)
      return r !== undefined ? `周围 ${r} 米` : '指定区域'
    }
    case 'aura': {
      const r = geomText(d.radius)
      return r !== undefined ? `身边 ${r} 米光环` : '光环'
    }
    case 'spawn': return '造出一个实体'
    default: return ''
  }
}

// ============================================================================
//  载荷
// ============================================================================

/** 载荷怎么说。这是规则描述的主干 */
/**
 * 一个载荷怎么说。
 *
 * ⚠ `names` 用来把 id 翻成人话（`status.shield` → 护盾、`entity.skeleton` → 骷髅）。
 *   不传的话会退回 id —— 但**该传的地方一定要传**：
 *   编辑器里有状态库和实体预设，命令行也有，它们都该给出名字。
 */
export function describePayload(p: Payload, names: DescribeNames = NO_NAMES): string {
  switch (p.kind) {
    case 'damage': {
      const type = p.damageType !== undefined && p.damageType !== '' ? `${damageTypeName(p.damageType)}` : ''
      if (p.mode === 'lethal') return `造成必杀${type}伤害（无视生命值）`
      const amount = describeValue(p.amount)
      // 有曲线的动态参数说成"按 X 造成 A~B 点"，别把曲线坐标念出来
      if (Array.isArray(p.amount.curve) && p.amount.curve.length > 0) {
        return `按${amount} 造成伤害`
      }
      return `造成 ${amount} 点${type}伤害`
    }

    case 'heal':
      return `回复 ${describeValue(p.amount)} 点生命`

    case 'attribute':
      return describeAttribute(p)

    case 'status': {
      const name = p.inline?.name ?? (p.statusId !== undefined ? nameOr(names, p.statusId, 'status') : '状态')
      const stacks = p.stacks !== undefined && p.stacks > 1 ? `×${num(p.stacks)}` : ''
      if (p.verb === 'remove') return `移除「${name}」`
      const dur = p.inline !== undefined
        ? p.inline.duration < 0 ? '，永久' : `，持续 ${num(p.inline.duration)} 秒`
        : ''
      return `挂上「${name}」${stacks}${dur}`
    }

    case 'displacement': {
      const how = p.mode === 'knockback' ? '击退'
        : p.mode === 'pull' ? '拉拽'
          : p.mode === 'teleport' ? '传送' : '冲刺'
      return `${how} ${describeValue(p.distance)} 米${p.airborne === true ? '并击飞' : ''}`
    }

    case 'perception': {
      const how = p.mode === 'reveal' ? '透视'
        : p.mode === 'mark' ? '标记' : '改变可见性'
      const dur = p.duration !== undefined ? `，持续 ${num(p.duration)} 秒` : ''
      return `${how}${dur}`
    }

    case 'spawn': {
      const count = p.count !== undefined && p.count > 1 ? ` ×${num(p.count)}` : ''
      const what = nameOr(names, p.entityId, 'entity')
      return `生成「${what}」${count}`
    }

    default:
      return '（未知载荷）'
  }
}

function damageTypeName(t: string): string {
  const table: Record<string, string> = {
    physical: '物理', fire: '火焰', ice: '冰霜', lightning: '闪电',
    arcane: '奥术', shadow: '暗影', holy: '神圣', poison: '毒素',
  }
  return table[t] ?? t
}

/** 属性载荷：从路径反推出人话 */
function describeAttribute(p: AttributePayload): string {
  const amount = describeValue(p.value)
  const n = typeof p.value.const === 'number' ? p.value.const : undefined

  if (p.op === 'reset') return '重置冷却'

  // 冷却
  if (p.path.includes('cooldown')) {
    if (n !== undefined) return n < 0 ? `冷却减少 ${num(-n)} 秒` : `冷却增加 ${num(n)} 秒`
    return `冷却 ${amount} 秒`
  }

  if (p.path.endsWith('energy.current')) {
    if (n !== undefined) return n < 0 ? `消耗 ${num(-n)} 能量` : `回复 ${num(n)} 能量`
    return `能量 ${amount}`
  }
  if (p.path.endsWith('hp.current')) {
    if (n !== undefined) return n < 0 ? `消耗 ${num(-n)} 生命` : `回复 ${num(n)} 生命`
    return `生命 ${amount}`
  }
  if (p.path.endsWith('hp.max')) return `生命上限 ${amount}`
  if (p.path.endsWith('energy.max')) return `能量上限 ${amount}`

  /*
   * ⚠ **血契**要说名字，不要把 `char.bloodPact.current` 打出来。
   *   它是这个游戏里最重要的资源之一（负值术式的燃料），
   *   而原来的说明写的是路径 —— 玩家看到的是"字符串"，不是"攒了 3 点血契"。
   */
  if (p.path.endsWith('bloodPact.current')) {
    if (n !== undefined) return n < 0 ? `消耗 ${num(-n)} 血契` : `积攒 ${num(n)} 血契`
    return `血契 ${amount}`
  }

  if (p.path.includes('moveScale') || p.path.includes('speed')) return `移速 ${amount}`
  if (p.path.includes('damageTaken')) return `受伤倍率 ${amount}`
  if (p.path.includes('damageDealt')) return `伤害倍率 ${amount}`

  /*
   * ⚠ `pipeline.*` 是**伪属性**：它改的不是某个人的属性，而是"这一下命中"本身。
   *   把这些名字说清楚，否则说明里会出现 `pipeline.cancelled 1` 这种
   *   只有写引擎的人才看得懂的东西。
   */
  if (p.path.startsWith('pipeline.')) {
    const tail = p.path.slice('pipeline.'.length)
    const table: Record<string, string> = {
      cancelled: '取消这一下',
      amount: '这一下的数值',
      crit: '这一下暴击',
      hit: '这一下命中',
    }
    return `${table[tail] ?? tail} ${amount}`
  }

  /*
   * 兜底：**说人话失败时不要把路径原文当说明**。
   *   写「某个属性」比打一串 `char.foo.bar` 强 ——
   *   后者看着像 bug，而前者明确告诉玩家"这条我认不出来"。
   */
  const tail = p.path.split('.').pop() ?? p.path
  const nice = attrName(p.path)
  return nice !== tail ? `${nice} ${amount}` : `某个属性 ${amount}`
}

// ============================================================================
//  时机
// ============================================================================

/**
 * 时机的**短说法**（"命中时" / "施放时" / "每 0.5 秒"）。
 *
 * ⚠ 单独导出：滑块标题也要用它（`collectLeaves` 那边给数字标"它属于哪条规则"）。
 *   两处各写一张表的话迟早不一致 —— 规则那一行写「命中时」、
 *   下面的滑块写「施放时」，玩家会以为它们不是同一条规则。
 */
export function whenName(when: TriggerEvent, every?: number): string {
  switch (when) {
    case 'onCast': return '施放时'
    case 'onHit': return '命中时'
    case 'onMiss': return '未命中时'
    case 'onCrit': return '暴击时'
    case 'onNonCrit': return '未暴击时'
    case 'onKill': return '击杀时'
    case 'onExpire': return '结束时'
    case 'onRemoved': return '被移除时'
    case 'onEnter': return '进入范围时'
    case 'onLeave': return '离开范围时'
    case 'onDamaged': return '被打时'
    case 'onLethalDamage': return '受到致命伤时'
    /*
     * ⚠ 和 `onDamaged` 生成的**必须不一样**：
     *   onDamaged      是"我挨了一下"
     *   onStatusApplied 是"我身上新挂上了一个东西"（血契的一条来源）
     *   写成同一句，玩家分不清自己写的是哪一个。
     */
    case 'onStatusApplied': return '身上新挂上状态时'
    case 'onLowHp': return '血量过低时'
    case 'onTick': return every !== undefined ? `每 ${num(every)} 秒` : '每秒'
    default: return String(when)
  }
}

/**
 * 效果的**短名字**：伤害 / 治疗 / 击退 / 挂状态 / 召唤……
 *
 * ⚠ 和 `describePayload` 的分工：那个说的是**整句话**
 *   （"造成 30 点物理伤害"），这个只是**类型名**。
 *   滑块标题要的是后者 —— 数值就在旁边，再写一遍"造成 30 点"是废话。
 */
export function effectName(p: Payload): string {
  switch (p.kind) {
    case 'damage': return p.mode === 'lethal' ? '必杀' : '伤害'
    case 'heal': return '治疗'
    case 'attribute': return '改属性'
    case 'status': return p.verb === 'remove' ? '驱散' : '挂状态'
    case 'displacement':
      return p.mode === 'knockback' ? '击退'
        : p.mode === 'pull' ? '拉拽'
          : p.mode === 'teleport' ? '传送' : '位移'
    case 'perception': return '感知'
    case 'spawn': return '召唤'
    default: return '效果'
  }
}

/** 触发时机怎么说。phaseId 会被替换成阶段名 */
export function describeWhen(rule: Rule, phaseName?: string): string {
  /*
   * ⚠ 阶段名**不加书名号**了。
   *   以前写的是「「前摇」结束时」——两层括号，读起来像代码。
   *   内容里的阶段名现在就是 前摇 / 命中 / 后摇 这种平实词，直接接在后面。
   *
   * ⚠ 「命中」这一个名字特殊处理：`命中结束` 是句病句，它要的是「命中时」。
   */
  const at = phaseName ?? ''
  if (rule.when === 'phaseComplete') return at === '命中' ? '命中时' : `${at}结束`
  if (rule.when === 'phaseEnter') return `${at}开始`
  if (rule.when === 'phaseInterrupt') return `${at}被打断`

  return whenName(rule.when, rule.every)
}

// ============================================================================
//  条件
// ============================================================================

/**
 * 条件怎么说。
 *
 * ⚠ 条件**不参与点数定价**（定价只知道"有什么动作"）。
 *   所以描述里必须把它写清楚 —— 不然玩家会以为
 *   "只在血量低于 30% 时触发"的那些效果是白拿的。
 */
export function describeCondition(c: Condition, names: DescribeNames = NO_NAMES): string {
  const who = c.who === 'target' ? '目标' : c.who === 'caster' ? '施法者' : '自己'
  /** 状态 id → 名字。查不到就退回 id（那时 id 是唯一能指认它的东西） */
  const st = (id: string): string => nameOr(names, id, 'status')

  switch (c.type) {
    case 'hasTag': return `${who}带标签「${String(c.value)}」`
    /*
     * ⚠ hasTag 和 hasStatusTag 生成的话必须不一样。
     *   玩家看到的要是"身上有护盾"和"它是亡灵"这两种完全不同的意思 ——
     *   写成同一句，条件写错了在界面上根本看不出来。
     */
    case 'hasStatusTag': return `${who}身上有带「${String(c.value)}」标签的状态`
    case 'hasStatus': return `${who}身上有「${st(String(c.value))}」`
    // ⚠ 阈值放在 range[0]，value 是状态 id —— 引擎就是这么读的（见 sim/conditions.ts）
    case 'stackAtLeast': return `${who}的「${st(String(c.value))}」至少 ${num(c.range?.[0] ?? 1)} 层`
    case 'hpBelow': return `${who}血量低于 ${Math.round(Number(c.value ?? 0) * 100)}%`
    case 'distanceIs': return c.range !== undefined ? `距离在 ${num(c.range[0])}~${num(c.range[1])} 米` : '距离合适'
    case 'targetCountIs': return c.range !== undefined ? `目标数在 ${num(c.range[0])}~${num(c.range[1])}` : '目标数合适'
    case 'isCrit': return c.value === 0 ? '本次未暴击' : '本次暴击'
    case 'hitKindIs': return c.value === 'heal' ? '本次是治疗' : '本次是伤害'
    /*
     * ⚠ `prevHit` 和 `onHit` 生成的话必须能分开：
     *   onHit   是"这一下打中了"（挂在某次命中上）
     *   prevHit 是"**上一段技能**碰到了人"（挂在技能链的连接上）
     *   写成同一句，玩家会分不清自己的条件是哪一个。
     */
    case 'prevHit': return '上一段技能碰到了人'
    case 'not': return `不满足（${(c.of ?? []).map(x => describeCondition(x, names)).join(' 且 ')}）`
    case 'anyOf': return (c.of ?? []).map(x => describeCondition(x, names)).join(' 或 ')
    case 'allOf': return (c.of ?? []).map(x => describeCondition(x, names)).join(' 且 ')
    default: return String(c.type)
  }
}

// ============================================================================
//  一条规则 = 时机 + 动作（+ 条件）
// ============================================================================

/** 描述一条规则的**全部动作**，可能有多条 */
export function describeActions(rule: Rule, names: DescribeNames = NO_NAMES): string {
  const parts: string[] = []

  for (const a of rule.then ?? []) {
    let text = describePayload(a.payload, names)

    // 载体只在不言自明的时候才写：给自己回血写"发射飞弹"是噪声
    const delivery = describeDelivery(a.delivery)
    if (delivery !== '' && a.payload.kind !== 'status') text = `${delivery}，${text}`

    if (a.target === 'self') text += '（自己）'
    parts.push(text)
  }

  return parts.length > 0 ? parts.join('；') : '（没有动作）'
}

/**
 * 一条规则的人话说明。
 *
 * 例句：「命中时 造成 30 点物理伤害」
 *
 * `phaseName` 是可选的回调 —— 阶段 id 在编译产物里带技能前缀，
 * 调用方知道怎么把它换回名字。
 */
export function describeRule(
  rule: Rule,
  phaseName?: string,
  names: DescribeNames = NO_NAMES,
): string {
  const when = describeWhen(rule, phaseName)
  const cond = (rule.if ?? []).length > 0
    ? `（若 ${(rule.if ?? []).map(c => describeCondition(c, names)).join(' 且 ')}）`
    : ''
  return `${when} ${cond}${describeActions(rule, names)}`.replace(' （', '（')
}

// ============================================================================
//  状态
// ============================================================================

/**
 * 状态的**一行说明** —— HUD 上鼠标移上去看的就是它（"司命·负重"那种）。
 *
 * 生成（不是手写）：状态的数值一改，这句话自己跟着变。
 * 手写的会漂移 —— 而「移速 -20%、持续 10 秒」正好是数值一改就该跟着变的那种话。
 *
 * ⚠ 放在这里而不是页面里，是为了**能被测**：`tests/describe.ts` 直接喂状态定义，
 *   不用把整个客户端 boot 起来。
 */
export function describeStatusTip(s: StatusDef): string {
  const body = describeStatus(s)
  const dur = s.duration < 0 ? '一直挂着' : `最长 ${s.duration} 秒`
  return body === '' ? `${s.name}（${dur}）` : `${s.name}：${body}（${dur}）`
}

/**
 * 一个状态改了什么。
 *
 * 状态是"装出来的"：冻结 = 禁用 move/attack/cast，霸体 = 免疫 hardCC……
 * 所以描述的重点是**它到底做了什么**，不是它叫什么。
 */
export function describeStatus(s: StatusDef): string {
  const bits: string[] = []

  for (const m of s.modifiers ?? []) {
    const v = m.value
    if (m.op === 'mul' && typeof v.const === 'number') {
      const pct = Math.round((v.const - 1) * 100)
      const dir = pct < 0 ? `${pct}%` : `+${pct}%`
      bits.push(`${attrName(m.path)} ${dir}`)
    } else {
      bits.push(`${attrName(m.path)} ${describeValue(v)}`)
    }
  }

  if ((s.disables ?? []).length > 0) {
    bits.push(`不能${(s.disables ?? []).map(capabilityName).join('/')}`)
  }
  if ((s.immuneTags ?? []).length > 0) {
    bits.push(`免疫「${(s.immuneTags ?? []).join('、')}」`)
  }
  for (const h of s.hooks ?? []) {
    if (h.absorb !== undefined) {
      bits.push(h.absorb.mode === 'damage'
        ? `吸收 ${num(h.absorb.perStack)} 点伤害`
        : `挡下 ${num(h.absorb.perStack)} 次命中`)
    }
  }

  const dur = s.duration < 0 ? '永久' : `${num(s.duration)} 秒`
  return bits.length > 0 ? `${dur}：${bits.join('，')}` : `${dur}（只是挂个标记）`
}

function attrName(path: string): string {
  const tail = path.split('.').pop() ?? path
  const table: Record<string, string> = {
    max: '上限', current: '当前值', regen: '回复速度', speed: '移速',
    moveScale: '移速', damageTaken: '受伤', damageDealt: '伤害',
  }
  if (path.endsWith('hp.max')) return '生命上限'
  if (path.endsWith('energy.max')) return '能量上限'
  if (path.endsWith('hp.current')) return '生命'
  if (path.endsWith('energy.current')) return '能量'
  return table[tail] ?? tail
}

function capabilityName(c: string): string {
  const table: Record<string, string> = {
    move: '移动', attack: '攻击', cast: '施法', turn: '转向',
  }
  return table[c] ?? c
}

/**
 * 伤害管线**六个阶段**的名字。
 *
 * ⚠ 存在的理由和别的一样：`stage: "modify"` 是**存进 JSON 的值**，
 *   而玩家要看的是「修正阶段」。以前标题里直接打 `modify 阶段` ——
 *   半中半英，而且是六个阶段里唯一没翻译的那一处。
 */
export function pipelineStageName(stage: string): string {
  const table: Record<string, string> = {
    raw: '原始',
    intercept: '拦截',
    modify: '修正',
    absorb: '吸收',
    apply: '结算',
    after: '之后',
  }
  return table[stage] ?? stage
}

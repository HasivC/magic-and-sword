/**
 * 投射物。
 *
 * 前面的所有载体都是"立即命中"—— 按下技能，伤害当场落地。
 * 投射物是第一种**会飞**的东西，它带来三个新问题：
 *
 *   1. 命中判定发生在**未来某一刻**，那时候发射它的施法早就结束了
 *      → 所以它必须自己带着要执行的动作和归属（ProjectileSpec）
 *   2. 飞行途中可能打空、可能飞过队友、可能飞过头
 *      → 所以要每 tick 做碰撞
 *   3. 穿透弹要记住已经打过谁
 *      → 所以有 hitIds
 *
 * 这三件事在纸上讨论时一条都没提过。
 *
 * ⚠ 这个文件和 pipeline.ts 是互相引用的：
 *     pipeline 要"放一个投射物出去"，projectile 要"执行投射物带的动作"。
 *   ESM 的处理方式是安全的 —— 两边都只在**函数体内**用对方，
 *   模块求值阶段谁都不会碰谁。但要知道这条边存在。
 */
import type { DeliverySpec } from '../schema.ts'
import type { ActionContext, Entity, ProjectileSpec, Vec3, World } from './types.ts'
import { distance, normalize2 } from './geom.ts'
import { cosDegreesFull, matchesValid, rotate2 } from './targeting.ts'
import { factionOf } from './status.ts'
import { canPassThrough, isObstacle, overlapsObstacle } from './barrier.ts'
import { executeAction, runTechniqueRules } from './pipeline.ts'
import { despawn, spawn } from './world.ts'

/** 投射物每 tick：看撞没撞上，然后交给位置积分去飞 */
export function tickProjectiles(world: World): void {
  const projectiles = world.entities.filter(e => e.alive && e.payload !== undefined)
  if (projectiles.length === 0) return

  for (const p of projectiles) {
    if (!p.alive) continue
    const spec = p.payload
    if (spec === undefined) continue

    // 用发射者的视角判断敌我 —— 投射物自己的阵营是 neutral
    const judge = world.entities.find(e => e.id === spec.sourceId) ?? p

    for (const target of world.entities) {
      /*
       * ⚠ 五行跳过条件**收在一个函数里**（`chaseableTargetOf`）—— 2026-09-30 日志 62
       *   抽出来的。它和索敌搜索 / 追踪的锁 / 弹射换目标读的是**同一批规矩**：
       *   死掉的、不是 `actor` 的、发射者自己、打过的、过不了 `valid` 的。
       *   ⚠ 两处各写一份的话，漂移方向不可预测（表现是"追着一个它打不动的东西飞"）。
       */
      if (!chaseableTargetOf(p, judge, spec, target)) continue
      if (distance(p.pos, target.pos) > p.radius + target.radius) continue

      spec.hitIds.push(target.id)
      runProjectileHit(world, p, target)

      /*
       * ⚠⚠ **这一发是不是已经没了**（2026-09-30 日志 58 加的）。
       *
       *   不穿透的子弹命中之后**当场消失**（`runProjectileHit` 末尾那一支）——
       *   老代码就是靠下面 `if (!spec.pierce) return` 收尾的，所以这一行看着像废话。
       *   ⚠ 但**弹射**让"这一发没了"多了一种情况：它命中之后**弹给下一个敌人**
       *   （`bounceToNextTarget` 在命中点**另放一颗新子弹**，把这一发用掉）。
       *   而穿透（`pierce: true`）的子弹**不会**因上面那一行退出循环 ——
       *   于是一颗**已经死了**的子弹会在这个 `for` 里继续找下一个目标：
       *   `runProjectileHit` 会被再调一次 ⇒ **又弹一条链出去**（一次命中有两条链）。
       *   ⚠ 那正是"弹射绕过保护 ⇒ 自反馈"的另一种形状，所以在这里断掉。
       *
       *   ⚠ 对**今天所有出厂内容**这一行是空操作：不穿透的照旧走下一行 `return`，
       *     而穿透的唯一一份（`skill.hunt`）**没有弹射副本**、永远死不了
       *     ⇒ `battle` 的哈希逐位不变就是证据。
       */
      if (!p.alive) return
      if (!spec.pierce) return
    }

    /*
     * ---- 屏障 ----
     *
     * ⚠ 玩家 2026-09-21 要的：
     *   > 竖起一道墙抵挡子弹……自己的子弹可以穿透而不被抵挡。
     *
     * 它**不是** `actor`，所以上面那段（只碰 actor）永远碰不到它 ——
     * 这是原先"用 area 做的墙挡不住子弹"的根因。
     *
     * ⚠ 判定只用**通行策略 + 形状**，不看 `spec.valid`：
     *   墙不是"目标"，是**障碍**。用 valid 判的话，"自己的子弹能不能穿"
     *   就变成了"这个子弹的 valid 里有没有 obstacle"这种东西，
     *   而那是内容作者完全猜不到的写法。策略写在墙上，读墙自己的字段。
     */
    if (!p.alive) continue
    for (const wall of world.entities) {
      if (!wall.alive || !isObstacle(wall)) continue
      if (wall.id === spec.sourceId) continue
      if (canPassThrough(world, wall, judge, 'projectile')) continue
      if (!overlapsObstacle(wall, p.pos, p.radius)) continue

      // 墙**挨了这一下**：伤害 / 次数盾 / 反伤全都由管线照常结算
      spec.hitIds.push(wall.id)
      world.events.push({
        type: 'blocked',
        blockerId: wall.id,
        projectileId: p.id,
        sourceId: spec.sourceId,
      })
      runProjectileHit(world, p, wall)

      if (!spec.pierce) {
        /*
         * ⚠ 不穿透的子弹**撞墙就消失**，而不是继续飞。
         *   这就是"墙挡住了"的可见结果。
         */
        despawn(world, p, 'expired')
        break
      }
    }

    /*
     * ---- 追踪：这一发自己找最近的敌人（修饰零件「追踪」，日志 56）----
     *
     * ⚠ 位置在**碰撞之后**：这一 tick 该撞的已经撞了（撞了的话 `p` 已经不活着，
     *   上面那两处都会让循环继续 / 提前退出）。放在**位置积分之前**是关键 ——
     *   拐弯必须在这一帧飞出去之前生效，否则表现是"子弹拐弯慢一帧"。
     *   ⚠ 它只改 `vel` / `facing`，**碰撞判定一个字都不动**。
     */
    if (p.alive) steerProjectile(world, p, judge, spec)
  }
}

/**
 * 让一颗**被「追踪」修饰**的投射物拐向**它在发射那一刻锁上的那个**敌人
 * （2026-09-30 日志 56 落地；**日志 62 改了"追多久"的口径**）。
 *
 * ## 玩家规格（原话）
 * > 追踪应该是一种**修饰技能**。正常的技能只沿着发射方向走，
 * > 而追踪技能**瞄准敌人**（部分技能比如**激光**不能被它修饰，看着不合理）
 *
 * 追问后确认：**自己找敌人**。
 *
 * ⚠⚠ 2026-09-30（日志 62）玩家又改了一条（原话）：
 * > 限制不应该是**射程**，而是**持续时间** —— 这样就**追到消失**
 *
 * ⇒ "什么时候丢锁"从**射程**换成了**这一发自己的寿命**：
 *   · `maxRange` 今天的语义是**索敌距离** —— **只在发射那一刻**用一次；
 *   · 锁上之后**不再每 tick 重新找**，目标跑多远都一路咬着，
 *     直到这一发自己飞完 `delivery.lifetime` 自然消失。
 *   ⚠ 所以"丢锁"这件事在代码里**已经不存在了**（这里读的是 `lockedId`）。
 *
 * ## 四条界线（一条一条对应到代码）
 *
 * 1. **只对"会飞的东西"有效**：调用点只有 `tickProjectiles` 一处，而投射物
 *    是**唯一会飞**的载体（`delivery.kind === 'projectile'`）——
 *    `beam` / `capsule` / `meleeArc` / `aura` / `area` / `self` 根本走不到这里
 *    （`sim/pipeline.ts` 只对投射物调 `spawnProjectile`）。
 *    ⇒ 非飞行载体被追踪修饰时"**什么都不做**"是**代码形状**保证的，
 *      不是这里的一行 `if`（更不是一句警告 —— 那是界面的事）。
 *
 * 2. **发射那一刻没找到 ⇒ 沿原发射方向直走，而且一路直走**：
 *    `lockedId === undefined` 直接返回，**一个字节都不改**。
 *    ⚠ 这里**没有"飞近一点再找"**：那次搜索**只有一次**（发射那一刻，
 *    `sim/pipeline.ts` 的 `spawnProjectileFrom`）。这正是玩家说的
 *    "**发射那一瞬间能找到多远的目标**"——不是飞行途中的射程。
 *
 * 3. ⚠ **锁上之后不换目标**：目标死了 / 已经打过了（穿透弹）/ 变得不合法 ⇒
 *    这一发**直走**（`chaseableTargetOf` 的跳过条件**和命中判定逐条对齐**）。
 *    ⚠ **不许"就近另找一个拐过去"**：那是玩家**没有定**的语义，
 *    而且表现上是"子弹中途自己改主意"——比"直走"坏得多。
 *
 * 4. ⚠⚠ **它不改施法时的瞄准**：`CastInstance.facing` / 落点在这儿根本读不到
 *    （这里只有 `Entity`）。它改的是**这一发自己的** `vel` / `facing`。
 *
 * ## 为什么没有三角函数（`src/sim/**` 的纯净性纪律）
 *
 * 引擎里方向是**单位向量**，"往哪边拐、转这一下会不会转过头"可以只靠
 * **叉积 + 点积**判出来：
 *   · `cross = vx·ty − vy·tx` 的**符号**就是"目标在我左边还是右边"
 *     （正值 = 逆时针一侧）；
 *   · "转过去之后还在不在目标那一侧" = **转完的叉积符号有没有变** ——
 *     变了就是**转过头了**，那就别转，一次对准。
 * ⇒ 一次 `rotate2` 查表（日志 53 的整圈角度表）就够，`sin` / `cos` 一次都不用。
 *   ⚠ `acos` 也没用（它和 `sin` / `cos` 是同一类东西，而且它会把"转了多少度"
 *     变成一个**连续**的数 —— 那正是"跨引擎逐位一致"最怕的东西）。
 *
 * ⚠ **可重放**：没有随机、没有 `Date`，全走白名单里的
 *   `Math.sqrt` / `Math.round` / `Math.max`，而角度表是**定值查表**
 *   （`rotate2` 把角度吸到最近的 5 度格），
 *   收敛之后方向**精确等于**目标方向（那一支取的是单位向量本身，不查表）。
 *
 * ⚠ **速度按标量重建**（`|vel|` 由 `sqrt` 算）而不是"每 tick 乘一个倍数"：
 *   乘倍数会让速度逐 tick 漂移，而"拐弯不该改变飞得多快"是玩家能看见的性质。
 *   算不出速度（`vel` 是 0）⇒ 什么都不做，等它自然消失。
 *
 * ⚠ 目标按**投射物自己的位置**找（不是发射者的位置）：发射那一刻它就站在
 *   出生点上，从那儿看谁最近。⚠ 出生点就是施法者身上
 *   （`spawnProjectile` 的 `pos: ctx.actor.pos`）—— 所以今天的实际效果是
 *   "以发射点为圆心"，而**换成一个真正会飞的发射点**（比如炮口）时这一行不用改。
 *   ⚠ 候选照旧过 `spec.valid`（`matchesValid`）：追踪换的是"追谁"，
 *     **不是"能不能打"** —— 它不会让一颗只打敌人的子弹去打自己人。
 *
 * ⚠ 目标和解算结果重合（方向算不出来）⇒ 什么都不做 —— "无事发生"，
 *   和"找不到敌人"同源（不许凭空挑一个转向方向）。
 */
function steerProjectile(
  world: World,
  p: Entity,
  judge: Entity,
  spec: ProjectileSpec,
): void {
  const homing = spec.homing
  if (homing === undefined) return

  const speed = Math.sqrt(p.vel.x * p.vel.x + p.vel.y * p.vel.y)
  if (speed < 1e-6) return

  /*
   * ⚠⚠ **目标只有发射那一刻那一个**（`spec.homing.lockedId`）。
   *
   *   这里**不再**拿 `homing.maxRange` 每 tick 重新搜一遍 —— 那是日志 56 的旧行为
   *   （"目标跑出射程就丢锁"），而玩家 2026-09-30 要的是"**追到消失**"：
   *   追多久 = **这一发自己的寿命**（飞完 `lifetime` 自然消失）。
   *   ⚠ 所以 `maxRange` 在这条路上**一次都不读**（它只在发射那一刻用一次）——
   *     这不是漏了，是这一片要的语义。见 `types.ts` 的 `ProjectileSpec.homing`。
   */
  const lockedId = homing.lockedId
  if (lockedId === undefined) return
  const target = world.entities.find(e => e.id === lockedId)
  if (target === undefined) return
  /*
   * ⚠ 锁还在，但这个人**已经不是"能追的目标"**了（死了 / 打过了 / 不合法）⇒ 直走。
   *   ⚠ 判据和搜索那一处**共用同一个函数**（`chaseableTargetOf`）——
   *     两处各写一份的话，迟早出现"子弹追着一个它打不动的东西飞"。
   */
  if (!chaseableTargetOf(p, judge, spec, target)) return

  const tx = target.pos.x - p.pos.x
  const ty = target.pos.y - p.pos.y
  const tlen = Math.sqrt(tx * tx + ty * ty)
  if (tlen < 1e-6) return
  const txu = tx / tlen
  const tyu = ty / tlen

  const vx = p.vel.x
  const vy = p.vel.y
  const cross = vx * tyu - vy * txu

  /*
   * 朝目标转的**符号**：
   *   · `cross > 0` ⇒ 目标在**逆时针**一侧 ⇒ `rotate2` 用正角
   *     （`rotate2` 的正角就是逆时针：`(1,0)` 转 +90 度得 `(0,1)`）；
   *   · `cross < 0` ⇒ 顺时针一侧 ⇒ 负角；
   *   · `cross === 0` ⇒ 正对着或者**正背对**着。正背对时两边一样远，
   *     这里用 `turnSignFor` 定一个**确定**的方向（⚠ 不许随机、不许"随便挑一边"）：
   *     `vx > 0` 走负角、`vx < 0` 走正角、`vx === 0` 看 `vy`。
   */
  const sign = cross > 0 ? 1 : cross < 0 ? -1 : turnSignFor(vx, vy)
  const step = homing.turnRate
  /*
   * ⚠⚠ **转速落成"整度"**（表是 **1 度一格**）：`k = round(step)` 度，至少 1 度。
   *
   *   ⚠ 这里**原来写的是 `round(step / 5)`**（表是 5 度一格那会儿）——
   *     做细到 1 度之后**必须一起改**，否则 `turnRate: 2` 会被算成 1 格 = **5 度**：
   *     参数写 2、引擎拐 5（2.5 倍的偏差），而且**看不出来**
   *     （实测抓到的：`turnRate: 2` 的子弹每 tick 正好拐 5 度）。
   *     这是"表的分辨率"和"参数的刻度"必须**一起改**的又一个例子。
   *
   *   ⚠ 为什么不是直接 `rotate2(v, step)`：`rotate2` 会把角度**吸到最近的整数度**，
   *     而"吸"的方向不可控 —— 5 度一格那会儿实测 `turnRate: 2` 被吸成 **0 度**
   *     ⇒ 那一档的子弹**永远直着飞**（参数看着设了、什么都不发生，**静默失效**）。
   *     ⇒ 玩家 2026-09-30 把表做细到 1 度（`sim/targeting.ts` 的 `turnIndex`），
   *     于是"1 度"成了一个真实的刻度，参数的合法下限也回到 **1**
   *     （`school.ts` 的 `MODIFIER_HOMING_TURN_MIN`）。
   *   ⚠ `Math.max(1, …)` 是**防御性兜底**（手改的存档 / 老数据里 `turnRate` 是 0 或缺失）：
   *     不兜的话"每 tick 转 0 度"= 永远收敛不了（比"直飞"更糟：它每 tick 都在算，就是不动）。
   */
  const steps = Math.max(1, Math.round(step))

  /*
   * ⚠⚠ **不许转过头** —— 这是这一片最容易写错的地方，**踩了三次**，
   *   三种坏法都留在这里（不然下一个人一定会再写一遍）：
   *
   *   ① "按 `turnRate` 转一下，转完点积 < 0 才贴到目标上" ——
   *      子弹在目标两侧**来回抖**（`turnRate` 12 度而余量只剩 6 度时转过去越过目标）
   *      ⇒ 下一 tick `cross` 变号 ⇒ 再往回转 ⇒ 速度方向反复横跳
   *      （实测：`(9.19, 7.71)` 和 `(7.71, 9.19)` 交替，表现是"在目标前面打摆子"）。
   *   ② "算一个 `align`（还要转多少度），`align <= step` 就一次对准" ——
   *      `align` 是从**离散表**里量出来的、只会**取整到格**（真实余量 1.6 度会报成 5 度）
   *      ⇒ `step` 是 2 度那一档时 `5 <= 2` 永远不成立 ⇒ 子弹**永远收敛不了**
   *      （实测：2 度/tick 的子弹一直不拐）。
   *   ③ "先算 `align`、比较方向写反" —— 更早的一版把判据写成"第一个 `cos ≥ c`"，
   *      而 `cos(0°) = 1` 恒成立 ⇒ `align` **永远返回 0** ⇒ 每一次都一次对准，
   *      转速参数**整个失效**（实测：2 度/tick 的子弹一 tick 就拐了 90 度）。
   *
   *   ⇒ 最终判据**不再依赖 `align` 的数值**，而是**试**：
   *     "转 `k` 格够不够"由 `rotate2` 自己回答 —— 转过去之后方向还在目标那一侧
   *     （叉积不变号）就说明**没转过**，那就照转；一旦会越过目标，就**一次对准**。
   *     这样"够不够"和"转多少"用的是**同一个** `rotate2`，两者的分辨率天然一致。
   */
  const ux = vx / speed
  const uy = vy / speed
  const turned = rotate2({ x: ux, y: uy }, steps * sign)
  const crossTurned = turned.x * tyu - turned.y * txu
  const dot = ux * txu + uy * tyu
  /*
   * ⚠ `dot >= cos(5°)` 是"已经基本对准了"（差得比一格表还少）——
   *   这一条是**防抖**的：不加它的话，方向在 0 度附近来回判"还要不要转"
   *   会依赖浮点最后几位（那正是"不可重放"的入口）。
   *   和上一条一起 ⇒ 对准之后方向**精确等于**目标方向（取的是 `txu/tyu`，不查表）。
   */
  const snap = dot >= cosDegreesFull(5) || crossTurned * cross <= 0
  const dir = snap
    ? { x: txu, y: tyu }
    : turned

  const next = normalize2(dir)
  p.vel.x = next.x * speed
  p.vel.y = next.y * speed
  /*
   * ⚠ `facing` 也要跟着改：客户端拿它画子弹的朝向（不写的话"拐弯的子弹"
   *   会画成直着飞）。⚠ `cast.facing` / 落点一个字都没动 —— 那是另一件事。
   */
  p.facing = next
}

/**
 * `cross === 0` 且**背对**目标时的确定性转向方向。
 *
 * ⚠ 它必须是一个**纯函数**（同样的两个数给同样的答案）：
 *   随机会让这一发不可重放，"看运气挑一边"会让同一份输入跑出两段轨迹。
 */
function turnSignFor(vx: number, vy: number): number {
  if (vx > 0) return -1
  if (vx < 0) return 1
  if (vy > 0) return -1
  return 1
}

/**
 * 搜索距离内**最近的合法目标** —— 找不到就是 `undefined`（调用方直走 / 不弹）。
 *
 * ⚠ **2026-09-30 日志 58：原来叫 `nearestHomingTarget`。** 改名的理由：
 *   「弹射」找"弹给谁"用的是**同一套候选规则**（`Infinity` = 不设射程），
 *   所以跳过条件必须**只有一处** —— 两处各写一份的话，迟早出现
 *   "追踪追着一个它打不动的东西飞、而弹射弹得过去"这种静默不一致。
 *   ⚠ **2026-09-30 日志 62**：它今天的调用方是**两个**，而且都不在"飞行途中"：
 *     · **追踪的索敌**（`acquireHomingTarget`，**发射那一刻**一次，带 `maxRange`）；
 *     · **弹射换目标**（`bounceToNextTarget`，**命中那一刻**一次，`Infinity`）。
 *   ⚠ `maxRange` 这个参数**一个字都没改**：追踪照旧传它自己读好的索敌距离。
 *
 * ⚠ 用**平方距离**比大小（不开根）：比较大小的结果和开根完全一样，
 *   而 `sqrt` 会引入一次浮点误差 —— 两个候选一样近时，"谁更近"就不确定了。
 *   返回给调用方的还是位置，距离那边自己再算一次。
 *
 * ⚠ 跳过条件**和命中判定逐条对齐**（`tickProjectiles` 那一段）：
 *   死掉的、不是 `actor` 的、发射者自己、已经打过的（`hitIds`，穿透弹和弹射靠它）、
 *   过不了 `valid` 的 —— 一条都不许少。少一条就会出现"子弹追着一个它打不动的东西飞"。
 *   ⚠ 那一份跳过条件**只有一处**（`chaseableTargetOf`）—— 追踪的锁、弹射的搜索、
 *     命中判定三处读的是**同一个函数**（日志 62 抽出来的）。
 *
 * ⚠ `maxRange` 传 `Infinity` ⇒ 不设射程（弹射用：它的旋钮里没有"多远之内"）——
 *   `bestSq` 初值就是 `Infinity`，而 `sq <= Infinity` 对任何有限距离都成立，
 *   所以那一条路**不需要**第二份实现。
 */
function nearestProjectileTarget(
  world: World,
  p: Entity,
  judge: Entity,
  spec: ProjectileSpec,
  maxRange: number,
): Entity | undefined {
  let best: Entity | undefined
  let bestSq = maxRange * maxRange

  for (const target of world.entities) {
    if (!chaseableTargetOf(p, judge, spec, target)) continue

    const dx = target.pos.x - p.pos.x
    const dy = target.pos.y - p.pos.y
    const sq = dx * dx + dy * dy
    /*
     * ⚠ `<=` 而不是 `<`：两个候选一样近时取**实体数组里靠前的那个** ——
     *   数组顺序是确定的（`spawn` 追加），所以结果仍然可重放。
     *   ⚠ 这里**不许**用 `<= bestSq` 之外的花样（比如"比半径"），那会让
     *     同一份输入在不同 tick 上挑中不同的人。
     */
    if (sq <= bestSq) {
      bestSq = sq
      best = target
    }
  }
  return best
}

/**
 * **这一发能不能把 `target` 当目标** —— 跳过条件**只有这一处**（2026-09-30 日志 62 抽出来的）。
 *
 * ⚠⚠ 为什么必须只有一处：命中判定（`tickProjectiles`）、索敌搜索
 *   （`nearestProjectileTarget`，追踪的发射那一刻 + 弹射的命中那一刻）、
 *   以及**锁上之后还追不追**（`steerProjectile`）**读的是同一批规矩**。
 *   少一条就会出现"子弹追着一个它打不动的东西飞"（打不到、但一直在拐），
 *   而两处各写一份的话，漂移的方向是不可预测的 —— 所以这里抽成一个纯函数。
 *
 * ⚠ 它**不改任何东西**（不写 `hitIds`、不碰 `alive`）：命中那一路读它只是为了
 *   "该不该结算"，真正的记账在调用方。
 */
function chaseableTargetOf(
  p: Entity,
  judge: Entity,
  spec: ProjectileSpec,
  target: Entity,
): boolean {
  if (!target.alive) return false
  if (target.kind !== 'actor') return false
  if (target.id === p.id || target.id === spec.sourceId) return false
  if (spec.hitIds.includes(target.id)) return false
  if (!matchesValid(judge, target, spec.valid)) return false
  return true
}

/**
 * **发射那一刻的索敌**：找出这一发该咬住谁，返回它的 `Entity.id`（找不到 ⇒ `undefined`）。
 *
 * ⚠⚠ 玩家 2026-09-30（日志 62）原话：
 *   > 那个"射程"旋钮：**改语义为「索敌距离」** —— **发射那一瞬间**能找到多远的目标
 *   > （找上了就一路咬到消失）
 *
 * ⇒ **只有这一次搜索**，而且用的是**投射物自己的出生点**（= 施法者身上）。
 *   结果写进 `spec.homing.lockedId`，之后**再也不改**：
 *   · 目标跑多远都不丢锁（追多久 = 这一发自己的 `lifetime`）；
 *   · 那一刻没找到 ⇒ 一路直走（**不许**"飞近一点再找"—— 那会让"索敌距离"
 *     变成一个每 tick 都在变的量，而玩家点名的是"**发射那一瞬间**"）。
 *
 * ⚠ 时机在 `spawnProjectile` **之后**（要拿到刚造出来的那个实体 id ——
 *   搜索会把"自己"排掉，所以 `p` 必须是真身）。位置**一个字节都没动过**
 *   （`integrate` 还没跑），所以这就是"出生点"。
 */
export function acquireHomingTarget(
  world: World,
  p: Entity,
  judge: Entity,
  spec: ProjectileSpec,
): number | undefined {
  const homing = spec.homing
  if (homing === undefined) return undefined
  const target = nearestProjectileTarget(world, p, judge, spec, homing.maxRange)
  return target?.id
}


/** 投射物打中了一个目标：执行它带的动作，然后决定要不要消失 */
function runProjectileHit(world: World, projectile: Entity, target: Entity): void {
  const spec = projectile.payload
  if (spec === undefined) return

  const owner = world.entities.find(e => e.id === spec.sourceId)
  const actor = owner ?? projectile

  /*
   * 注意这里**没有 cast**。
   *
   * 子弹飞出去的时候那次施法早就结束了。所以投射物命中的动作读不到
   * skill.* 和蓄力量 —— 那是设计如此，不是遗漏。
   * 想留信息就在发射时算好，或者用 projectile 自己的属性。
   */
  const ctx: ActionContext = {
    world,
    self: actor,
    actor,
    target,
    depth: 0,
    validTargets: spec.valid,
  }
  if (spec.techniqueId !== undefined) ctx.sourceId = spec.techniqueId
  /*
   * ⚠⚠ **弹射的衰减落在这一行**（修饰零件「弹射」，日志 58）。
   *
   *   它是"**这一段**的**伤害**乘多少"：第一段是 1（全额），
   *   每弹一次乘一遍 `damageFalloff`（连乘，**不用 `pow`** —— 纯净性白名单里没有它）。
   *
   *   ⚠⚠ **它只乘伤害、不乘治疗**（日志 58 第二版，用户裁定："衰减只作用于伤害，
   *     不要乘 heal —— 用户原话只说'伤害'，而且'会弹的治疗'是另一种机制"）。
   *     落地在 `executeAction` 的 `damage` 那一支（`heal` 照原值）。
   *
   *   ⚠ 为什么不做成"把 `spec.actions` 里那份 `amount` 乘一下"：
   *     那份 `amount` 是**未解算**的 `ValueSpec`（可能是 `{ ref: 'weapon.damage' }`），
   *     命中那一刻才知道是多少 —— 所以只能在结算时乘（见 `ActionContext.amountScale`）。
   *   ⚠ 缺省 1 ⇒ 除了弹射，引擎里没有任何一条路写它。
   */
  if (spec.bounce !== undefined && spec.bounce.amountScale !== 1) {
    ctx.amountScale = spec.bounce.amountScale
  }

  for (const action of spec.actions) {
    executeAction(ctx, action)
  }

  /*
   * 告诉客户端"这一发落地了，特效播在这儿"。
   *
   * ⚠ 投射物在**发射**时是不发这条的（它自己就是实体，客户端已经在画它了）——
   *   但**命中**是另一件事：命中火花得打在目标身上，不是发射点上。
   *
   * ⚠⚠ **坐标是命中点，不是目标中心。**
   *
   *   玩家指出来过：打在体型大的 Boss 身上时，用中心点会**看起来像自爆** ——
   *   火花从怪物身体正中炸开，而不是在身上炸开。
   *
   *   所以这里算的是**接触点**：从目标中心朝子弹来的方向，退到目标表面。
   *
   *   为什么不直接用子弹当前位置：碰撞判定是"距离 ≤ 子弹半径 + 目标半径"，
   *   判中的那一刻子弹其实停在**目标表面外一个子弹半径**的地方 ——
   *   小怪（半径 0.5）配 0.5 的子弹，火花会飘在离身体半米的空气里。
   *   投影到表面上，火花才真的是"打在身上"。
   */
  if (spec.vfx !== undefined) {
    const dx = projectile.pos.x - target.pos.x
    const dy = projectile.pos.y - target.pos.y
    const len = Math.sqrt(dx * dx + dy * dy)
    // 正中命中时 dx/dy 可能是 0（理论上），那就退回子弹来的方向
    const ux = len > 1e-6 ? dx / len : projectile.vel.x
    const uy = len > 1e-6 ? dy / len : projectile.vel.y
    const surface = target.radius

    world.events.push({
      type: 'deliveryFired',
      casterId: spec.sourceId,
      techniqueId: spec.techniqueId ?? '',
      kind: 'projectile',
      from: { x: target.pos.x + ux * surface, y: target.pos.y + uy * surface },
      dir: { x: projectile.vel.x, y: projectile.vel.y },
      hitCount: 1,
      vfx: spec.vfx,
      ...(spec.damageType !== undefined ? { damageType: spec.damageType } : {}),
    })
  }

  // 让发射者的 onHit / onKill 规则有机会响应 —— 子弹打中了，账要记在它头上
  if (spec.techniqueId !== undefined && owner !== undefined) {
    const tech = world.techniques.get(spec.techniqueId)
    if (tech !== undefined) {
      runTechniqueRules(world, tech, owner, 'onHit', { target })
      if (!target.alive) runTechniqueRules(world, tech, owner, 'onKill', { target })
    }
  }

  /*
   * ⚠⚠ ---- **弹射：打中了，看看要不要弹给下一个**（修饰零件「弹射」，日志 58）----
   *
   *   位置在**别的事情都做完之后**：伤害 / 特效 / onHit 规则都按"这一下真的打中了"
   *   照常发生（弹射不改这一下的任何结果），只有"这一发接下来去哪"变了。
   *
   *   ⚠ 弹出去的是**一颗新子弹**（不是把这一颗掉头）—— 理由写在 `ProjectileSpec.bounce`
   *     那一段：掉头的话 `lifetime` 已经飞掉一半，第二段可能**静默过期**
   *     （表现是"我设了弹 2 次，它一次都没弹"）。
   *
   *   ⚠ 弹不弹**和 `pierce` 无关**：弹射把这一发**用掉了**（下一段是新子弹），
   *     所以"穿透 + 弹射"今天等于"弹射"。（⚠ 这个组合还没有玩家裁定，见日志 58 第 5 节。）
   */
  if (bounceToNextTarget(world, projectile, spec)) {
    /*
     * 这一发到此为止。⚠ 它**不是**"打空了"：它是"打中了，然后跳走了" ——
     * 但 `removed` 事件今天只有这几个 reason（`expired` 是"它没了"那一个），
     * 所以这里照旧报 `expired`，而**跳走这件事**由新子弹自己体现（它就在世界里飞）。
     */
    projectile.alive = false
    world.events.push({ type: 'removed', id: projectile.id, reason: 'expired' })
    return
  }

  if (!spec.pierce) {
    projectile.alive = false
    world.events.push({ type: 'removed', id: projectile.id, reason: 'expired' })
  }
}

/**
 * 打中之后**弹给最近的另一个敌人**（修饰零件「弹射」，2026-09-30 日志 58）。
 *
 * ## 玩家规格（原话）
 * > 被它修饰的**投射物命中一个敌人之后** → **弹给最近的另一个敌人**，
 * > 最多 **N 次**，每次**衰减**（"弹两下的闪电"）。
 *
 * ## 落成什么
 *
 * 在**命中点**放一颗**新子弹**，朝下一个敌人飞，并且：
 *   · `left - 1`（还能弹几次，0 就是"到此为止"）；
 *   · `amountScale × damageFalloff`（下一段的**伤害**乘多少 —— 连乘，**不用 `pow`**；
 *     ⚠ **治疗不乘**，见 `ActionContext.amountScale`）；
 *   · `hitIds` **照抄带过去**（这一条同时管住两件事，见下）。
 *
 * ## 三条界线（一条一条对应到代码）
 *
 * 1. **不许弹回刚打过的那个**（玩家原话：否则来回弹）：
 *    `hitIds` 里已经**包含刚打中的这个**（`tickProjectiles` 在调用命中处理**之前**
 *    就 push 了）⇒ 找下一个目标时它天然被跳过。
 *    ⚠ 而且**打过的全都带上**（不只是"刚那个"）：否则 A→B→A→B 这种
 *      "来回弹"照样成立 —— 而玩家要的是"弹给**另一个**敌人"。
 *    新子弹的 `hitIds` 是**拷贝**（`[...spec.hitIds]`），不是共享引用：
 *    两颗子弹各自记自己打过谁，互不污染（和穿透弹同一个道理）。
 *
 * 2. **找不到下一个 ⇒ 就停在那儿**（玩家原话：不弹）：
 *    返回 `false` ⇒ 调用方走原来那条路（不穿透的子弹照旧消失）。
 *    "没有别的敌人时停下"和"没目标就什么都不发生"同源，**不是**"随便挑一个方向"。
 *
 * 3. **目标按子弹自己的位置找**（和 `steerProjectile` 同一条口径）：
 *    它已经在飞了，从它**现在**站的地方看谁最近，才是"离命中点最近的那个"。
 *    候选照旧过 `spec.valid`（弹射换的是"**弹给谁**"，**不是"能不能打"**）。
 *
 * ## ⚠ 没有三角函数、没有随机（`src/sim/**` 的纯净性纪律）
 *
 * 这里只要一个**方向**：`(目标位置 − 子弹位置)` 归一化 (`sqrt`)。
 * 没有 `sin` / `cos` / `atan2`，也没有"随便挑一边"—— 解算不出方向就**不弹**。
 *
 * ## ⚠⚠ 上限、以及"为什么这一条链不会无限自反馈"
 *
 * `left` 在**发射那一刻**就被 `min(数据要的, MAX_ACTION_DEPTH)` 夹过
 * （`sim/pipeline.ts` 的 `spawnProjectileFrom`），而这里每弹一次**减一**：
 * 链的长度因此**最多**是深度上限。⚠ 这不是"另一份上限"——
 * 它读的就是 `executeAction` 用的那**一个** `MAX_ACTION_DEPTH`（`src/limits.ts`），
 * 理由见那里：弹射每段都是一颗新子弹，`depth` **不会自然累加**，
 * 所以那个数是这条链唯一的刹车。
 */
function bounceToNextTarget(world: World, projectile: Entity, spec: ProjectileSpec): boolean {
  const bounce = spec.bounce
  if (bounce === undefined || bounce.left <= 0) return false

  // 用发射者的视角判断敌我 —— 和 `tickProjectiles` 里那个 `judge` 同一个算法
  const judge = world.entities.find(e => e.id === spec.sourceId) ?? projectile
  /*
   * ⚠ `Infinity` = **不设射程**：玩家规格里弹射没有"多远之内"这个旋钮
   *   （只有次数和衰减），所以它找的是"**最近的另一个敌人**"，不分远近。
   *   ⚠ 追目标那一段的跳过条件**和命中判定逐条对齐**（死掉的 / 不是 actor /
   *     发射者自己 / 打过的 / 过不了 valid）—— 少一条就会出现"弹给一个它打不动的东西"。
   */
  const next = nearestProjectileTarget(world, projectile, judge, spec, Infinity)
  if (next === undefined) return false

  const dx = next.pos.x - projectile.pos.x
  const dy = next.pos.y - projectile.pos.y
  const len = Math.sqrt(dx * dx + dy * dy)
  // 方向和目标中心重合（算不出方向）⇒ 不弹 —— "无事发生"，不许凭空挑一个方向
  if (len < 1e-6) return false
  const dir = { x: dx / len, y: dy / len }

  const nextSpec: ProjectileSpec = {
    actions: spec.actions,
    valid: spec.valid,
    sourceId: spec.sourceId,
    // ⚠ 拷贝：打过的都带过去（不弹回任何一个打过的），两颗子弹各记各的
    hitIds: [...spec.hitIds],
    pierce: spec.pierce,
    bounce: {
      left: bounce.left - 1,
      // ⚠ 连乘（不用 `pow`：它不在纯净性白名单里）；每一段都在上一段的基础上再乘一次
      amountScale: bounce.amountScale * bounce.damageFalloff,
      damageFalloff: bounce.damageFalloff,
    },
  }
  if (spec.techniqueId !== undefined) nextSpec.techniqueId = spec.techniqueId
  if (spec.vfx !== undefined) nextSpec.vfx = spec.vfx
  if (spec.damageType !== undefined) nextSpec.damageType = spec.damageType

  /*
   * ⚠ 飞行参数照抄（`spec.flight`）—— 不抄的话第二段会吃 `spawnProjectile` 的默认值：
   *   一颗慢悠悠的大火球弹一下会变成一支快箭，而且**没有任何地方会说**。
   * ⚠ 出生点是**命中点**（子弹现在的位置，已经贴在目标表面上了）——
   *   从"打中的地方"跳出去，才是玩家能看见的"弹过去"。
   * ⚠ `tags` 照抄（伤害类型那一条挂在上面）。
   */
  const delivery: DeliverySpec = {
    kind: 'projectile',
    ...(spec.flight !== undefined
      ? { speed: spec.flight.speed, lifetime: spec.flight.lifetime, radius: spec.flight.radius }
      : {}),
  }
  spawnProjectile(world, {
    pos: { x: projectile.pos.x, y: projectile.pos.y, z: projectile.pos.z },
    dir,
    delivery,
    tags: [...projectile.tags],
    spec: nextSpec,
  })
  return true
}

export interface ProjectileInit {
  pos: Vec3
  /** 单位方向向量 */
  dir: { x: number; y: number }
  delivery?: DeliverySpec
  tags: string[]
  spec: ProjectileSpec
}

/**
 * 造一个投射物。
 *
 * 飞行参数从 delivery 取：`speed` 决定多快，`lifetime` 决定飞多久。
 * 飞完 lifetime 就自然消失 —— 这就是"打空了"。
 */
export function spawnProjectile(world: World, init: ProjectileInit): Entity {
  const speed = init.delivery?.speed ?? 12
  const lifetime = init.delivery?.lifetime ?? 1.2
  /*
   * ⚠ 投射物的 `radius` 是**子弹自己的大小**，不是"够得着多远" ——
   *   所以它只认数字。写了 `{ ref: 'weapon.reach' }` 的话退到默认值
   *   （校验器会报 `GEOM_REF_IGNORED` 提醒这是写错了地方：
   *     武器射程该写在扇形/线形载体的 geometry 上，不是子弹的粗细上）。
   */
  const radius = typeof init.delivery?.radius === 'number' ? init.delivery.radius : 0.25
  const dir = normalize2(init.dir)

  /*
   * ⚠ 投射物必须继承发射者的阵营，不能用 neutral。
   *
   * 用 neutral 的话，`isHostileTo` 一律返回 false ——
   * 于是「无下限」那种 valid: ['enemy'] 的光环永远匹配不到子弹，
   * 而"靠近的东西自动减速"本来就该管子弹。实测踩到过。
   */
  const owner = world.entities.find(e => e.id === init.spec.sourceId)

  /*
   * ⚠ **把这一类的飞行参数抄进 `spec`**（2026-09-30 日志 58，「弹射」要的）。
   *
   *   弹射发生在**命中那一刻**，那时候手里只有 `spec`（那次施法早结束了），
   *   而下一段必须**照原样再飞一次**（同样的速度 / 存在时间 / 粗细）。
   *   ⚠ 抄的是这里**夹过默认值之后**的三个数（不是 `delivery` 里那两个可选字段）——
   *     否则"没写 lifetime"的子弹第一段吃默认值、第二段吃 `undefined`。
   */
  init.spec.flight = { speed, lifetime, radius }

  return spawn(world, {
    kind: 'projectile',
    tags: init.tags,
    faction: owner === undefined ? 'neutral' : factionOf(owner),
    pos: { x: init.pos.x, y: init.pos.y, z: init.pos.z },
    vel: { x: dir.x * speed, y: dir.y * speed, z: 0 },
    facing: dir,
    lifetime,
    radius,
    payload: init.spec,
    ownerId: init.spec.sourceId,
  })
}

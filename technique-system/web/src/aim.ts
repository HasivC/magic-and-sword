/**
 * 鼠标位置 → 瞄准方向。**纯函数**，不碰 DOM —— 所以浏览器之外也能测。
 *
 * ## 为什么单独一个文件
 *
 * 玩家 2026-09-21 报的 bug：
 *
 *   > 使用铁剑时鼠标左键的攻击始终朝向正右方而不是鼠标方向
 *
 * 老代码里这一句是元凶之一：
 *
 * ```ts
 * const len = Math.sqrt(dx * dx + dy * dy)
 * if (len < 1e-6) return { x: 1, y: 0 }   // ← 凭空造一个"正右方"
 * ```
 *
 * "算不出方向"和"朝右"是**两件事**，而它们被写成了同一件事。
 * 指针还没动过（`mouse` 是初始的 (0,0)）、canvas 尺寸是 0、
 * 或者指针恰好落在画面正中时，`dx` 和 `dy` 同时为 0 ——
 * 于是每一次攻击都朝正右方，而且**没有任何地方会报错**：
 * 看起来像"瞄准坏了"，查起来却什么都正常。
 *
 * 现在的规矩：算不出来就**沿用上一次的方向**（调用方把 `fallback` 传进来，
 * 也就是"角色当前朝向"—— 它本来就是上一 tick 算出来的瞄准方向）。
 * 不猜。
 *
 * ## 单位
 *
 * 参数都是**页面像素**（`clientX/clientY` 那种），不是米。
 * 返回的是**单位向量**，所以"每米多少像素"在归一化里自己约掉了 ——
 * 这个函数不需要知道 `PX_PER_M`。
 */

/** canvas 在页面里的位置和大小（`getBoundingClientRect()` 的四个字段） */
export interface Rect {
  left: number
  top: number
  width: number
  height: number
}

/**
 * 算瞄准方向。
 *
 * @param pointer  指针在**页面**里的位置（`clientX/clientY`）。没收到过就是 undefined
 * @param rect     canvas 的 `getBoundingClientRect()`
 * @param fallback 算不出来时用它（传"角色当前朝向"）
 */
export function aimFromPointer(
  pointer: { x: number; y: number } | undefined,
  rect: Rect,
  fallback: { x: number; y: number },
): { x: number; y: number } {
  if (pointer === undefined) return { ...fallback }

  /*
   * ⚠ 先减掉 canvas 自己的左上角。
   *
   *   直接拿 `clientX - 画面宽/2` 只有当 canvas 正好贴在视口左上角时才成立
   *   （以前就是这么写的：`#stage` 是 `position: fixed; inset: 0`，
   *   所以当时它对）。但布局一变 —— 加了边距、外面套了一层、页面滚了 ——
   *   那套算法就开始静默地偏，而**偏多少看不出来**。
   */
  const dx = pointer.x - rect.left - rect.width / 2
  const dy = pointer.y - rect.top - rect.height / 2
  const len = Math.sqrt(dx * dx + dy * dy)

  /*
   * ⚠ 这里**不返回 (1,0)**。指针正好落在画面正中时方向是"没有方向"，
   *   不是"朝右" —— 沿用它上一次的方向（也就是角色当前朝向）才对。
   */
  if (len < 1e-6) return { ...fallback }
  return { x: dx / len, y: dy / len }
}

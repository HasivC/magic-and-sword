# 特效预览图

**这些 PNG 是自动生成的，不是手画的。** 重跑：

```bash
node tools/preview-fx.ts                          # 裂地斩：扇形挥砍（物理）
node tools/preview-fx.ts --type fire              # 换个伤害类型看配色
node tools/preview-fx.ts --kind beam              # 看光束
node tools/preview-fx.ts --type arcane --out docs/fx
```

## 为什么有这些图

特效是给人看的，但在命令行里**看不见自己刚写的东西** ——
那意味着"这道刀光好不好看"只能靠玩家反馈，一轮迭代要几分钟。

所以 `web/src/fx.ts` 把"画什么"抽成了**图元列表**（纯函数 `deliveryPrims`），
`tools/preview-fx.ts` 用**同一份图元**在自己的光栅化器里渲染成 PNG。
只有一份几何真相，浏览器和这个工具是两个消费者。

⚠ **它不替代真机。** 滤镜、字形、真实缩放下的抗锯齿仍然是浏览器的活。
它回答的是"形状对不对、层次够不够、颜色搭不搭"——
也就是**能离线判断的那一半**。

## 当前这批图

| 文件 | 是什么 |
|---|---|
| `meleeArc-physical-t*.png` | 裂地斩实际用的那一种（物理：白芯 + 青边） |
| `meleeArc-fire-t*.png` | 同一套几何换来火焰配色，验证上色表 |
| `meleeArc-arcane-t*.png` | 奥术配色 |

`t020` ~ `t240` 是同一发技能在 0.02s ~ 0.24s 的样子。
**别只看一张** —— 拖尾是随时间扫过去的，单帧说明不了什么。

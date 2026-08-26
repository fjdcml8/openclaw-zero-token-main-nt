#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
标准 CAD 绘图脚本模板（ezdxf）
================================
本文件是模板：模型或用户修改「几何配置区」后另存为新脚本再运行。

使用流程（配合 deepseek-web 的工具注入）：
  1. read   查看本模板（可选，帮助理解结构）
  2. write  把修改后的脚本写到 ~/.openclaw-zero/workspace/cad_draw.py
  3. exec   运行: python3 ~/.openclaw-zero/workspace/cad_draw.py
  4. 生成的 .dxf 会自动保存到桌面，程序打印文件路径

特性：
  - ezdxf 未安装时自动 pip 安装（首次需联网）
  - 只改「几何配置区」即可画新图，其余代码不用动
  - 支持矩形 / 圆 / 直线；要加新形状见 build_drawing() 里的扩展示例

退出码：0 = 成功；非 0 = 失败（错误信息打印到 stdout）
"""

import os
import subprocess
import sys

# ---------------------------------------------------------------------------
# 【几何配置区】—— 只改这里，其余代码无需改动
# ---------------------------------------------------------------------------
# 输出文件名（不含扩展名，保存到桌面）
OUTPUT_NAME = "cad_draw"

# 画布尺寸（仅参考，ezdxf 无实际单位限制）
CANVAS_W = 100.0
CANVAS_H = 100.0

# 几何定义：需要哪种形状就保留哪种，并修改参数
GEOMETRY = {
    # 矩形: x0,y0 左下角, w 宽, h 高
    "rectangle": {"x0": 10.0, "y0": 10.0, "w": 80.0, "h": 60.0},
    # 圆: cx,cy 圆心, r 半径
    "circle": {"cx": 50.0, "cy": 40.0, "r": 15.0},
    # 直线: 起点 x1,y1 -> 终点 x2,y2
    "line": {"x1": 10.0, "y1": 80.0, "x2": 90.0, "y2": 80.0},
    # 点: x,y
    # "point": {"x": 50.0, "y": 50.0},
    # 圆弧: cx,cy 圆心, r 半径, start_deg 起始角, end_deg 结束角
    # "arc": {"cx": 50.0, "cy": 40.0, "r": 20.0, "start_deg": 0.0, "end_deg": 90.0},
}
# ---------------------------------------------------------------------------

DESKTOP = os.path.expanduser("~/Desktop")


def ensure_ezdxf() -> None:
    """ezdxf 未安装时自动安装。"""
    try:
        import ezdxf  # noqa: F401
    except ImportError:
        print("⚙️ 未检测到 ezdxf，正在安装（首次需联网）...")
        subprocess.check_call([sys.executable, "-m", "pip", "install", "ezdxf"])
        print("✅ ezdxf 安装完成")


def build_drawing(doc):
    """按 GEOMETRY 配置生成图形。新增几何类型时在此扩展即可。"""
    msp = doc.modelspace()

    if "rectangle" in GEOMETRY:
        r = GEOMETRY["rectangle"]
        pts = [
            (r["x0"], r["y0"]),
            (r["x0"] + r["w"], r["y0"]),
            (r["x0"] + r["w"], r["y0"] + r["h"]),
            (r["x0"], r["y0"] + r["h"]),
        ]
        msp.add_lwpolyline(pts, close=True)

    if "circle" in GEOMETRY:
        c = GEOMETRY["circle"]
        msp.add_circle((c["cx"], c["cy"]), radius=c["r"])

    if "line" in GEOMETRY:
        ln = GEOMETRY["line"]
        msp.add_line((ln["x1"], ln["y1"]), (ln["x2"], ln["y2"]))

    if "point" in GEOMETRY:
        p = GEOMETRY["point"]
        msp.add_point((p["x"], p["y"]))

    if "arc" in GEOMETRY:
        a = GEOMETRY["arc"]
        msp.add_arc(
            center=(a["cx"], a["cy"]),
            radius=a["r"],
            start_angle=a["start_deg"],
            end_angle=a["end_deg"],
        )


def main() -> int:
    ensure_ezdxf()
    import ezdxf as _ezdxf

    doc = _ezdxf.new("R2010", setup=True)
    doc.units = 4  # mm

    build_drawing(doc)

    os.makedirs(DESKTOP, exist_ok=True)
    out_path = os.path.join(DESKTOP, f"{OUTPUT_NAME}.dxf")
    doc.saveas(out_path)
    print(f"✅ 已生成: {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

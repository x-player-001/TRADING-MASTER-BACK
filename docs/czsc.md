一、缠论核心算法三部曲
1. 去包含关系处理 (remove_include)
这是缠论最基础的预处理步骤，将原始K线转换为符合缠论分析的标准形态。
算法逻辑：
┌─────────────────────────────────────────────┐
│ 输入: k1(已处理), k2(已处理), k3(原始)      │
│                                             │
│ Step 1: 确定方向                             │
│   - k1.high < k2.high → 向上趋势             │
│   - k1.high > k2.high → 向下趋势             │
│                                             │
│ Step 2: 判断包含关系                         │
│   条件: (k2完全包含k3) OR (k3完全包含k2)      │
│                                             │
│ Step 3: 根据方向处理包含                     │
│   向上: high=max(), low=max()               │
│   向下: high=min(), low=min()               │
│                                             │
│ Step 4: 合并成交量和元素                     │
│   vol = k2.vol + k3.vol                    │
│   elements = k2.elements + [k3]            │
└─────────────────────────────────────────────┘
关键点：
向上趋势时取高位（max高、max低），确保不压低走势
向下趋势时取低位（min高、min低），确保不抬高走势
合并后的K线保留原始K线信息在elements列表中
2. 分型识别 (check_fx)
分型是缠论的基本结构单元，分为顶分型(G)和底分型(D)。
算法公式：

顶分型 (Mark.G):
  k1.high < k2.high > k3.high  AND
  k1.low  < k2.low  > k3.low
  ↓
  中间K线高低点同时高于两侧 → 顶分型

底分型 (Mark.D):
  k1.high > k2.high < k3.high  AND
  k1.low  > k2.low  < k3.low
  ↓
  中间K线高低点同时低于两侧 → 底分型
数学表达：
FX(k₁, k₂, k₃) = {
  G, if H(k₂) > max(H(k₁), H(k₃)) ∧ L(k₂) > max(L(k₁), L(k₃))
  D, if H(k₂) < min(H(k₁), H(k₃)) ∧ L(k₂) < min(L(k₁), L(k₃))
  ∅, otherwise
}
序列要求：
分型必须顶底交替出现
连续同类型分型会触发错误日志
3. 笔的识别 (check_bi)
笔是由两个相邻异性分型构成的价格波动，是缠论的基本交易单位。
成笔条件 (analyze.py:174-178):

条件1: 价格突破
  ↓
  向上笔: fx_b.fx > fx_a.fx  (顶分型高于底分型)
  向下笔: fx_b.fx < fx_a.fx  (底分型低于顶分型)

条件2: 无包含关系
  ↓
  NOT (fx_a包含fx_b OR fx_b包含fx_a)

条件3: 最小长度约束
  ↓
  len(bars_between) >= czsc_min_bi_len
  (默认至少5-7根K线)

✓ 三个条件同时满足 → 成笔
✗ 任一条件不满足 → 继续等待
识别流程：
原始K线序列
    ↓
去包含处理 (remove_include)
    ↓
无包含K线序列 (bars_ubi)
    ↓
分型识别 (check_fxs)
    ↓
分型序列 [FX₁, FX₂, FX₃...]
    ↓
笔识别 (check_bi)
    ↓
笔序列 [BI₁, BI₂, BI₃...]



✅ 中枢实现情况
1. 中枢对象定义
中枢对象已经从Python迁移到Rust实现以提高性能：
# czsc/objects.py:17
from rs_czsc._rs_czsc import ZS  # Rust实现的中枢对象
中枢核心属性（从注释代码可见逻辑）：
class ZS:
    bis: List[BI]  # 构成中枢的笔序列
    
    # 核心属性
    zg: float      # 中枢上沿 = min(前3笔的high)
    zd: float      # 中枢下沿 = max(前3笔的low)
    zz: float      # 中枢中轴 = (zg + zd) / 2
    
    gg: float      # 中枢最高点 = max(所有笔的high)
    dd: float      # 中枢最低点 = min(所有笔的low)
    
    sdt: datetime  # 开始时间
    edt: datetime  # 结束时间
    sdir: Direction # 第一笔方向
    edir: Direction # 最后一笔方向
2. 中枢判断算法
中枢形成条件
# 基本定义：至少3笔构成中枢
def __is_zs(bis: List[BI]) -> bool:
    zs = ZS(bis=bis)
    return zs.zd < zs.zg  # 下沿必须小于上沿
中枢有效性验证
@property
def is_valid(self) -> bool:
    """中枢是否有效"""
    if self.zg < self.zd:
        return False  # 上下沿倒置，无效
    
    # 中枢内的每一笔必须与上下沿有交集
    for bi in self.bis:
        if (zg >= bi.high >= zd or          # 笔高点在中枢内
            zg >= bi.low >= zd or           # 笔低点在中枢内
            bi.high >= zg > zd >= bi.low):  # 笔完全穿越中枢
            continue
        else:
            return False  # 有笔不与中枢交集，无效
    
    return True
中枢计算公式
给定笔序列 [BI₁, BI₂, BI₃, ...]

中枢上沿 ZG = min(BI₁.high, BI₂.high, BI₃.high)
中枢下沿 ZD = max(BI₁.low, BI₂.low, BI₃.low)

必须满足: ZG > ZD (上沿高于下沿)

示例：
BI₁: low=100, high=110
BI₂: low=105, high=115  
BI₃: low=102, high=112

ZG = min(110, 115, 112) = 110
ZD = max(100, 105, 102) = 105
中枢区间: [105, 110]
3. 中枢相关信号函数
项目中有多个基于中枢的信号函数：
(1) 中枢共振信号 (czsc/signals/cxt.py:238)
def cxt_zhong_shu_gong_zhen_V221221(cat: CzscSignals, 
                                     freq1="日线", 
                                     freq2="60分钟"):
    """大小级别中枢共振，类二买共振
    
    信号逻辑：
    1. 不区分上涨或下跌中枢
    2. 次级别中枢DD(最低点) > 本级别中枢中轴
    3. 次级别向下笔出底分型 → 开多
       次级别向上笔出顶分型 → 开空
    
    信号列表：
    - '日线_60分钟_中枢共振V221221_看多_任意_任意_0'
    - '日线_60分钟_中枢共振V221221_看空_任意_任意_0'
    """
    
    # 判断大级别中枢
    big_zs = ZS(bis=max_freq.bi_list[-3:])
    
    # 判断小级别中枢
    small_zs = ZS(bis=min_freq.bi_list[-3:])
    
    # 共振条件
    if small_zs.dd > big_zs.zz:  # 小周期最低点 > 大周期中轴
        if min_freq.bi_list[-1].direction == Direction.Down:
            return "看多"  # 次级别向下笔，买入信号
核心思想：多周期中枢位置共振，增强信号可靠性。
(2) 中枢震荡信号 (czsc/signals/zdy.py:181)
def 中枢震荡(freq1="5分钟", freq2="60分钟"):
    """中枢震荡短差操作
    
    信号逻辑：
    1. 中枢笔数 >= 3笔 (排除盘背构成的中枢)
    2. 中枢上沿做空，中枢下沿做多
    
    开空条件(中枢上沿)：
    - H >= 本级别中枢上沿价格
    - (H - 中枢上沿) < 中枢高度
    - (H - P) * 3 < 中枢高度
    - MACD黄白线死叉确立
    
    信号列表：
    - '中枢震荡_5分钟#60分钟_BS辅助V230406_看多_任意_任意_0'
    - '中枢震荡_5分钟#60分钟_BS辅助V230406_看空_任意_任意_0'
    """
核心思想：在中枢区间内进行高抛低吸。
(3) 分型强弱与中枢关系 (czsc/signals/cxt.py:59)
def cxt_fx_power_V221107(c: CZSC, di=1):
    """倒数第di个分型的强弱
    
    信号列表：
    - '15分钟_D1F_分型强弱_强顶_有中枢_任意_0'
    - '15分钟_D1F_分型强弱_弱底_无中枢_任意_0'
    """
    last_fx: FX = c.fx_list[-di]
    v1 = f"{last_fx.power_str}{last_fx.mark.value[0]}"
    v2 = "有中枢" if last_fx.has_zs else "无中枢"
    #     ^^^^^^^^^^^^^^^^^^^^^^^^
    #     分型是否有中枢特征
核心思想：分型背后是否有中枢支撑，影响其可靠性。
4. 中枢序列获取工具
# czsc/utils/sig.py
from czsc.utils.sig import get_zs_seq

def get_zs_seq(bis: List[BI]) -> List[ZS]:
    """从笔序列中提取所有中枢
    
    遍历笔序列，识别满足中枢条件的笔组合
    """
5. 测试用例
项目有专门的中枢测试：
# test/test_objects.py:32
def test_zs():
    """测试中枢对象"""
    from czsc.objects import ZS
    from czsc.analyze import CZSC
    
    # 使用mock数据生成K线
    df = mock.generate_symbol_kines("000001", "日线")
    bars = [RawBar(...) for row in df.iterrows()]
    
    c = CZSC(bars)
    
    # 构造中枢
    if len(c.bi_list) >= 5:
        zs = ZS(c.bi_list[-5:-2])
        assert zs.zd < zs.zg, "中枢下沿应该小于上沿"
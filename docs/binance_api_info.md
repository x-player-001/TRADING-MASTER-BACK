大户持仓量多空比
接口描述
大户的多头和空头总持仓量占比，大户指保证金余额排名前20%的用户。 多仓持仓量比例 = 大户多仓持仓量 / 大户总持仓量 空仓持仓量比例 = 大户空仓持仓量 / 大户总持仓量 多空持仓量比值 = 多仓持仓量比例 / 空仓持仓量比例

HTTP请求
GET /futures/data/topLongShortPositionRatio

请求权重
0

请求参数
名称	类型	是否必需	描述
symbol	STRING	YES	
period	ENUM	YES	"5m","15m","30m","1h","2h","4h","6h","12h","1d"
limit	LONG	NO	default 30, max 500
startTime	LONG	NO	
endTime	LONG	NO	
若无 startime 和 endtime 限制， 则默认返回当前时间往前的limit值
仅支持最近30天的数据
IP限频为1000次/5min
响应示例
[
    { 
         "symbol":"BTCUSDT",
	      "longShortRatio":"1.4342",// 大户多空持仓量比值
	      "longAccount": "0.5344", // 大户多仓持仓量比例
	      "shortAccount":"0.4238", // 大户空仓持仓量比例
	      "timestamp":"1583139600000"
    
     },
     
     {
         
         "symbol":"BTCUSDT",
	      "longShortRatio":"1.4337",
	      "longAccount": "0.5891", 
	      "shortAccount":"0.4108", 	                
	      "timestamp":"1583139900000"
	               
        },   
	    
]


大户账户数多空比
接口描述
持仓大户的净持仓多头和空头账户数占比，大户指保证金余额排名前20%的用户。一个账户记一次。 多仓账户数比例 = 持多仓大户数 / 总持仓大户数 空仓账户数比例 = 持空仓大户数 / 总持仓大户数 多空账户数比值 = 多仓账户数比例 / 空仓账户数比例

HTTP请求
GET /futures/data/topLongShortAccountRatio

请求参数
名称	类型	是否必需	描述
symbol	STRING	YES	
period	ENUM	YES	"5m","15m","30m","1h","2h","4h","6h","12h","1d"
limit	LONG	NO	default 30, max 500
startTime	LONG	NO	
endTime	LONG	NO	
若无 startime 和 endtime 限制， 则默认返回当前时间往前的limit值
仅支持最近30天的数据
IP限频为1000次/5min
响应示例
[
    { 
         "symbol":"BTCUSDT",
	      "longShortRatio":"1.8105",// 大户多空账户数比值
	      "longAccount": "0.6442", // 大户多仓账户数比例
	      "shortAccount":"0.3558", // 大户空仓账户数比例
	      "timestamp":"1583139600000"
    },
    {
         
         "symbol":"BTCUSDT",
	      "longShortRatio":"1.8233",
	      "longAccount": "0.5338", 
	      "shortAccount":"0.3454", 	                
	      "timestamp":"1583139900000"
	}
]



多空持仓人数比
接口描述
多空持仓人数比

HTTP请求
GET /futures/data/globalLongShortAccountRatio

请求权重
0

请求参数
名称	类型	是否必需	描述
symbol	STRING	YES	
period	ENUM	YES	"5m","15m","30m","1h","2h","4h","6h","12h","1d"
limit	LONG	NO	default 30, max 500
startTime	LONG	NO	
endTime	LONG	NO	
若无 startime 和 endtime 限制， 则默认返回当前时间往前的limit值
仅支持最近30天的数据
IP限频为1000次/5min
响应示例
[
    { 
         "symbol":"BTCUSDT",
	      "longShortRatio":"0.1960", // 多空人数比值
	      "longAccount": "0.6622", // 多仓人数比例
	      "shortAccount":"0.3378", // 空仓人数比例
	      "timestamp":"1583139600000"
    
     },
     
     {
         
         "symbol":"BTCUSDT",
	      "longShortRatio":"1.9559",
	      "longAccount": "0.6617", 
	      "shortAccount":"0.3382", 	                
	      "timestamp":"1583139900000"
	               
        },   
	    
]



合约主动买卖量
接口描述
合约主动买卖量

HTTP请求
GET /futures/data/takerlongshortRatio

请求权重
0

请求参数
名称	类型	是否必需	描述
symbol	STRING	YES	
period	ENUM	YES	"5m","15m","30m","1h","2h","4h","6h","12h","1d"
limit	LONG	NO	default 30, max 500
startTime	LONG	NO	
endTime	LONG	NO	
若无 startime 和 endtime 限制， 则默认返回当前时间往前的 limit 值
仅支持最近 30 天的数据
IP限频为1000次/5min
响应示例
[
  {
    buySellRatio: "1.5586",
    buyVol: "387.3300", // 主动买入量
    sellVol: "248.5030", // 主动卖出量
    timestamp: "1585614900000",
  },

  {
    buySellRatio: "1.3104",
    buyVol: "343.9290",
    sellVol: "248.5030",
    timestamp: "1583139900000",
  },
]
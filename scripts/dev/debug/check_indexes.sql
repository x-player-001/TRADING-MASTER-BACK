-- 检查OI表的索引状态

-- 1. 检查 open_interest_snapshots 表的所有索引
SELECT
    INDEX_NAME as '索引名称',
    COLUMN_NAME as '列名',
    SEQ_IN_INDEX as '列顺序',
    NON_UNIQUE as '是否非唯一',
    INDEX_TYPE as '索引类型',
    COMMENT as '备注'
FROM INFORMATION_SCHEMA.STATISTICS
WHERE TABLE_SCHEMA = 'trading_master'
  AND TABLE_NAME = 'open_interest_snapshots'
ORDER BY INDEX_NAME, SEQ_IN_INDEX;

-- 2. 检查 oi_anomaly_records 表的所有索引
SELECT
    INDEX_NAME as '索引名称',
    COLUMN_NAME as '列名',
    SEQ_IN_INDEX as '列顺序',
    NON_UNIQUE as '是否非唯一',
    INDEX_TYPE as '索引类型',
    COMMENT as '备注'
FROM INFORMATION_SCHEMA.STATISTICS
WHERE TABLE_SCHEMA = 'trading_master'
  AND TABLE_NAME = 'oi_anomaly_records'
ORDER BY INDEX_NAME, SEQ_IN_INDEX;

-- 3. 分析表统计信息是否最新
SELECT
    TABLE_NAME as '表名',
    TABLE_ROWS as '估计行数',
    AVG_ROW_LENGTH as '平均行长度',
    DATA_LENGTH as '数据大小',
    INDEX_LENGTH as '索引大小',
    UPDATE_TIME as '最后更新时间'
FROM INFORMATION_SCHEMA.TABLES
WHERE TABLE_SCHEMA = 'trading_master'
  AND TABLE_NAME IN ('open_interest_snapshots', 'oi_anomaly_records');

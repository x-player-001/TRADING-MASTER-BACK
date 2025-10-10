/**
 * 转换JSON文件中的时间格式
 * 从 UTC+0 日/月/年 → UTC+8 年-月-日
 */

const fs = require('fs');

// 读取原始JSON
const rawData = JSON.parse(fs.readFileSync('./bnb-15.json', 'utf8'));

// 转换时区函数: UTC+0 → UTC+8
function convertToUTC8(dateStr) {
  // 输入格式: "9/10/2025 08:30:00" (日/月/年 UTC+0)
  const [datePart, timePart] = dateStr.split(' ');
  const [day, month, year] = datePart.split('/');
  const [hour, minute, second] = timePart.split(':');

  // 创建UTC时间
  const utc0 = new Date(Date.UTC(year, month - 1, day, hour, minute, second));

  // 加8小时转为UTC+8
  const utc8 = new Date(utc0.getTime() + 8 * 60 * 60 * 1000);

  // 格式化为 YYYY-MM-DD HH:mm:ss
  const yyyy = utc8.getUTCFullYear();
  const mm = String(utc8.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(utc8.getUTCDate()).padStart(2, '0');
  const hh = String(utc8.getUTCHours()).padStart(2, '0');
  const min = String(utc8.getUTCMinutes()).padStart(2, '0');
  const ss = String(utc8.getUTCSeconds()).padStart(2, '0');

  return `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss}`;
}

console.log('开始转换时区...');
console.log('原始记录数:', rawData.RECORDS.length);
console.log('');

// 转换所有记录
const convertedRecords = rawData.RECORDS.map((record, index) => {
  const convertedRecord = {
    ...record,
    open_time: convertToUTC8(record.open_time),
    close_time: convertToUTC8(record.close_time)
  };

  // 显示前3条转换示例
  if (index < 3) {
    console.log(`记录 ${index + 1}:`);
    console.log(`  原始 open_time:  ${record.open_time}`);
    console.log(`  转换 open_time:  ${convertedRecord.open_time}`);
    console.log(`  原始 close_time: ${record.close_time}`);
    console.log(`  转换 close_time: ${convertedRecord.close_time}`);
    console.log('');
  }

  return convertedRecord;
});

// 构建新的JSON对象
const convertedData = {
  RECORDS: convertedRecords
};

// 保存到新文件
fs.writeFileSync('./bnb-15-utc8.json', JSON.stringify(convertedData, null, 2), 'utf8');

console.log('✅ 转换完成！');
console.log('新文件已保存为: bnb-15-utc8.json');
console.log('');
console.log('时间范围 (UTC+8):');
console.log('  最早:', convertedRecords[convertedRecords.length - 1].open_time);
console.log('  最晚:', convertedRecords[0].open_time);

/**
 * 分割快照文件脚本
 * 用途：将大的快照JSON文件分割成多个小文件
 * 运行命令: node dev/maintenance/split_snapshots.js
 */

const fs = require('fs');
const path = require('path');

// ============================================================================
// 📋 配置
// ============================================================================
const CONFIG = {
  input_file: 'data_exports/snapshots_2025-11-20T09-04-13.json',
  output_dir: 'data_exports',
  split_count: 3,  // 分成3个文件
};

// ============================================================================
// 📊 主程序
// ============================================================================

async function split_snapshots() {
  console.log('\n' + '='.repeat(80));
  console.log('✂️  快照文件分割工具');
  console.log('='.repeat(80));
  console.log('');

  const input_path = path.join(process.cwd(), CONFIG.input_file);

  // 检查文件是否存在
  if (!fs.existsSync(input_path)) {
    console.error(`❌ 文件不存在: ${input_path}`);
    process.exit(1);
  }

  console.log(`📂 读取文件: ${CONFIG.input_file}`);
  const file_size_mb = (fs.statSync(input_path).size / 1024 / 1024).toFixed(2);
  console.log(`📏 文件大小: ${file_size_mb} MB`);
  console.log('');

  // 读取JSON文件
  console.log('⏳ 解析JSON数据...');
  const json_data = JSON.parse(fs.readFileSync(input_path, 'utf-8'));

  console.log(`✅ 数据加载完成`);
  console.log(`   - 总快照数: ${json_data.data.length.toLocaleString()} 条`);
  console.log(`   - 币种数: ${json_data.export_info.total_symbols}`);
  console.log('');

  // 计算每个文件的数据量
  const total_snapshots = json_data.data.length;
  const snapshots_per_file = Math.ceil(total_snapshots / CONFIG.split_count);

  console.log(`📊 分割策略:`);
  console.log(`   - 分割数量: ${CONFIG.split_count} 个文件`);
  console.log(`   - 每个文件约: ${snapshots_per_file.toLocaleString()} 条快照`);
  console.log('');

  // 开始分割
  console.log('✂️  开始分割文件...');
  console.log('');

  const timestamp = json_data.export_info.export_time.split('T')[0].replace(/-/g, '');
  const saved_files = [];

  for (let i = 0; i < CONFIG.split_count; i++) {
    const start_idx = i * snapshots_per_file;
    const end_idx = Math.min((i + 1) * snapshots_per_file, total_snapshots);
    const chunk_data = json_data.data.slice(start_idx, end_idx);

    // 构建输出文件名
    const output_filename = `snapshots_${timestamp}_part${i + 1}_of_${CONFIG.split_count}.json`;
    const output_path = path.join(CONFIG.output_dir, output_filename);

    // 准备输出数据
    const output_json = {
      export_info: {
        ...json_data.export_info,
        part: i + 1,
        total_parts: CONFIG.split_count,
        part_snapshot_count: chunk_data.length,
        original_file: path.basename(CONFIG.input_file)
      },
      data: chunk_data
    };

    // 写入文件
    fs.writeFileSync(output_path, JSON.stringify(output_json, null, 2));

    const file_size = (fs.statSync(output_path).size / 1024 / 1024).toFixed(2);
    saved_files.push({
      filename: output_filename,
      size: file_size,
      count: chunk_data.length
    });

    console.log(`  ✅ Part ${i + 1}/${CONFIG.split_count}: ${output_filename}`);
    console.log(`     - 快照数: ${chunk_data.length.toLocaleString()} 条`);
    console.log(`     - 文件大小: ${file_size} MB`);
    console.log('');
  }

  // 统计摘要
  console.log('='.repeat(80));
  console.log('📊 分割完成统计');
  console.log('='.repeat(80));
  console.log('');

  console.log('📁 生成的文件:');
  saved_files.forEach((file, idx) => {
    console.log(`  ${idx + 1}. ${file.filename}`);
    console.log(`     大小: ${file.size} MB, 快照数: ${file.count.toLocaleString()} 条`);
  });
  console.log('');

  const total_size = saved_files.reduce((sum, f) => sum + parseFloat(f.size), 0).toFixed(2);
  console.log(`💾 总大小: ${total_size} MB`);
  console.log('');

  console.log('💡 提示:');
  console.log('  - 原始文件未删除，如需删除请手动执行');
  console.log(`  - 删除命令: rm ${CONFIG.input_file}`);
  console.log('');

  process.exit(0);
}

// 运行分割
split_snapshots().catch(error => {
  console.error('\n❌ 分割失败:', error.message);
  console.error(error.stack);
  process.exit(1);
});

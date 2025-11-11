/**
 * OI数据库优化测试脚本 (通过SSH隧道连接)
 *
 * 使用方法:
 * 1. 确保已配置SSH免密登录到服务器
 * 2. node scripts/test_db_optimization_ssh.js
 */

require('dotenv').config();
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

const SERVER_IP = process.env.SERVER_IP || '106.53.217.216';
const SSH_USER = 'root';  // 修改为你的SSH用户名
const LOCAL_PORT = 33060;  // 本地转发端口

/**
 * 建立SSH隧道
 */
async function setup_ssh_tunnel() {
  console.log(`🔐 建立SSH隧道: ${SSH_USER}@${SERVER_IP}:3306 -> localhost:${LOCAL_PORT}`);

  const ssh_command = `ssh -f -N -L ${LOCAL_PORT}:localhost:3306 ${SSH_USER}@${SERVER_IP}`;

  try {
    await execAsync(ssh_command);
    console.log('✅ SSH隧道建立成功');

    // 等待隧道建立
    await new Promise(resolve => setTimeout(resolve, 2000));
    return true;
  } catch (error) {
    console.error('❌ SSH隧道建立失败:', error.message);
    console.log('\n提示: 请确保已配置SSH免密登录:');
    console.log(`   ssh-copy-id ${SSH_USER}@${SERVER_IP}`);
    return false;
  }
}

/**
 * 关闭SSH隧道
 */
async function cleanup_ssh_tunnel() {
  try {
    // 查找SSH隧道进程
    const { stdout } = await execAsync(`ps aux | grep "ssh.*${LOCAL_PORT}:localhost:3306" | grep -v grep`);
    if (stdout) {
      const pid = stdout.trim().split(/\s+/)[1];
      await execAsync(`kill ${pid}`);
      console.log('🔌 SSH隧道已关闭');
    }
  } catch (error) {
    // 忽略错误
  }
}

/**
 * 数据库连接配置 (通过SSH隧道)
 */
const DB_CONFIG = {
  host: 'localhost',  // 通过SSH隧道，使用localhost
  port: LOCAL_PORT,   // 使用本地转发端口
  user: process.env.MYSQL_USER || 'root',
  password: process.env.MYSQL_PASSWORD || '',
  database: process.env.MYSQL_DATABASE || 'trading_master',
  multipleStatements: true
};

// 导入原测试脚本的所有函数
const original_script = fs.readFileSync(__dirname + '/test_db_optimization.js', 'utf-8');

// 提取并执行测试函数
eval(original_script.split('// 运行测试')[0]);

/**
 * 主函数 (带SSH隧道)
 */
async function main_with_ssh() {
  console.log('🚀 OI数据库性能优化测试 (通过SSH隧道)');
  console.log('═'.repeat(80));

  // 1. 建立SSH隧道
  const tunnel_ok = await setup_ssh_tunnel();
  if (!tunnel_ok) {
    console.error('\n❌ 无法建立SSH隧道，测试终止');
    process.exit(1);
  }

  try {
    // 2. 执行原测试流程
    await main();
  } finally {
    // 3. 清理SSH隧道
    await cleanup_ssh_tunnel();
  }
}

// 运行测试
main_with_ssh().catch(error => {
  console.error('Fatal error:', error);
  cleanup_ssh_tunnel().then(() => process.exit(1));
});

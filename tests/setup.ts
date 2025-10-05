import dotenv from 'dotenv';

// 加载测试环境变量
dotenv.config({ path: '.env.test' });

// 设置测试超时
jest.setTimeout(30000);

// 全局测试设置
beforeAll(async () => {
  // 这里可以设置测试数据库连接等
  console.log('🧪 测试环境初始化...');
});

afterAll(async () => {
  // 清理测试资源
  console.log('🧹 测试环境清理...');
});

// 每个测试前的设置
beforeEach(() => {
  // 重置模拟数据等
});

afterEach(() => {
  // 清理每个测试后的状态
});
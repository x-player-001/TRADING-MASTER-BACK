import * as dotenv from 'dotenv';
dotenv.config({ override: true });

import { ConfigManager } from '../src/core/config/config_manager';
import { SRLevelRepository } from '../src/database/sr_level_repository';

async function main() {
  const config_manager = ConfigManager.getInstance();
  config_manager.initialize();

  const repo = new SRLevelRepository();
  
  console.log('正在清空 sr_alerts 表...');
  await repo.truncate_alerts();
  console.log('✅ sr_alerts 表已清空');
  
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

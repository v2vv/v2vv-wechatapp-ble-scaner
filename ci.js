const ci = require('miniprogram-ci');
const path = require('path');
const fs = require('fs');

async function main() {
  const args = process.argv.slice(2);
  const isUpload = args.includes('--upload');
  const isTerminal = args.includes('--terminal') || args.includes('-t');

  function getArg(name) {
    const idx = args.indexOf(name);
    if (idx !== -1 && idx + 1 < args.length) {
      return args[idx + 1];
    }
    return null;
  }

  // 读取项目配置
  const projectConfigPath = path.resolve(__dirname, 'project.config.json');
  let appid = 'wxc7048d689e2957c5';
  let projectPath = path.resolve(__dirname, 'dist');
  let setting = {
    es6: false,
    es7: false,
    minify: true,
    autoPrefixWXSS: true,
  };

  if (fs.existsSync(projectConfigPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(projectConfigPath, 'utf8'));
      if (config.appid) appid = config.appid;
      if (config.miniprogramRoot) {
        projectPath = path.resolve(__dirname, config.miniprogramRoot);
      }
      if (config.setting) {
        setting = { ...setting, ...config.setting };
      }
    } catch (e) {
      console.warn('⚠️ 读取 project.config.json 异常，使用默认配置:', e.message);
    }
  }

  appid = getArg('--appid') || process.env.MINIPROGRAM_APPID || appid;
  const specifiedKey = getArg('--key') || getArg('-k') || process.env.MINIPROGRAM_PRIVATE_KEY_PATH;

  // 密钥路径候选
  const candidateKeyPaths = [
    specifiedKey,
    path.resolve(__dirname, `private.${appid}.key`),
    path.resolve(__dirname, 'private.key'),
    path.resolve(__dirname, 'keys', `private.${appid}.key`),
    path.resolve(__dirname, 'keys', 'private.key'),
    path.resolve(process.env.HOME || '', `private.${appid}.key`),
    path.resolve(process.env.HOME || '', '.keys', `private.${appid}.key`),
  ].filter(Boolean);

  let privateKeyPath = candidateKeyPaths.find((p) => fs.existsSync(p));

  // 环境变量直接传私钥文本内容
  if (!privateKeyPath && process.env.MINIPROGRAM_PRIVATE_KEY) {
    const tmpKeyPath = path.resolve(__dirname, `.temp_private.${appid}.key`);
    fs.writeFileSync(tmpKeyPath, process.env.MINIPROGRAM_PRIVATE_KEY, 'utf8');
    privateKeyPath = tmpKeyPath;
  }

  if (!privateKeyPath) {
    console.error('\n' + '='.repeat(60));
    console.error('❌ 未找到小程序代码上传密钥 (Private Key)！');
    console.error('='.repeat(60));
    console.error('\n💡 【如何获取与配置私钥】:');
    console.error('1. 登录微信公众平台 (https://mp.weixin.qq.com)');
    console.error('2. 进入「开发」->「开发管理」->「开发设置」->「小程序代码上传」');
    console.error(`3. 生成并下载代码上传密钥文件（如: private.${appid}.key）`);
    console.error('4. 注意：请关闭「小程序代码上传 IP 白名单」或将当前机器公网 IP 加入白名单');
    console.error('5. 将下载的密钥放置在项目根目录：');
    console.error(`   👉 ${path.resolve(__dirname, `private.${appid}.key`)}`);
    console.error('   或者通过参数指定：npm run ci:preview -- --key /path/to/private.key\n');
    process.exit(1);
  }

  // 检查 dist 编译产物
  if (!fs.existsSync(projectPath) || !fs.existsSync(path.join(projectPath, 'app.json'))) {
    console.error(`\n❌ 未找到编译产物目录: ${projectPath}`);
    console.error('💡 请先运行编译命令: npm run build:weapp\n');
    process.exit(1);
  }

  const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf8'));
  const version = getArg('--version') || getArg('-v') || pkg.version || '1.0.0';
  const desc = getArg('--desc') || (isUpload ? `Upload v${version}` : `Preview at ${new Date().toLocaleString('zh-CN')}`);
  const robot = parseInt(getArg('--robot') || '1', 10);
  const qrcodeFormat = isTerminal ? 'terminal' : (getArg('--format') || 'image');
  const qrcodeOutputDest = getArg('--output') || path.resolve(__dirname, 'preview-qrcode.jpg');
  const pagePath = getArg('--page');
  const searchQuery = getArg('--query');

  console.log('\n' + '='.repeat(50));
  console.log(`🚀 miniprogram-ci: ${isUpload ? '【代码上传】' : '【生成预览码】'}`);
  console.log('='.repeat(50));
  console.log(`- AppID:    ${appid}`);
  console.log(`- 项目目录: ${projectPath}`);
  console.log(`- 密钥文件: ${privateKeyPath}`);
  console.log(`- 机器人ID: ${robot}`);

  const project = new ci.Project({
    appid,
    type: 'miniProgram',
    projectPath,
    privateKeyPath,
    ignores: ['node_modules/**/*', '.git/**/*', '*.md', '*.log'],
  });

  if (isUpload) {
    console.log(`- 上传版本: ${version}`);
    console.log(`- 描述信息: ${desc}\n`);
    console.log('📦 正在上传代码至微信平台...');
    const uploadResult = await ci.upload({
      project,
      version,
      desc,
      setting,
      robot,
      onProgressUpdate: (task) => {
        if (typeof task === 'string') console.log(`[CI] ${task}`);
        else if (task && task.status) console.log(`[CI] ${task.status}: ${task.message || ''}`);
      },
    });
    console.log('\n' + '='.repeat(50));
    console.log('✅ 代码上传成功！');
    console.log('='.repeat(50));
    console.log(uploadResult);
  } else {
    console.log(`- 输出格式: ${qrcodeFormat}`);
    if (qrcodeFormat === 'image') console.log(`- 保存路径: ${qrcodeOutputDest}`);
    if (pagePath) console.log(`- 启动页面: ${pagePath}`);
    if (searchQuery) console.log(`- 启动参数: ${searchQuery}`);
    console.log('\n📱 正在生成预览二维码...');

    const previewOptions = {
      project,
      desc,
      setting,
      robot,
      qrcodeFormat,
      qrcodeOutputDest,
      onProgressUpdate: (task) => {
        if (typeof task === 'string') console.log(`[CI] ${task}`);
        else if (task && task.status) console.log(`[CI] ${task.status}: ${task.message || ''}`);
      },
    };

    if (pagePath) previewOptions.pagePath = pagePath;
    if (searchQuery) previewOptions.searchQuery = searchQuery;

    const previewResult = await ci.preview(previewOptions);

    console.log('\n' + '='.repeat(50));
    console.log('🎉 预览生成成功！');
    console.log('='.repeat(50));
    if (qrcodeFormat === 'image') {
      console.log(`📸 预览二维码图片已保存至: ${qrcodeOutputDest}`);
    }
    console.log('👉 使用微信扫码即可在手机上进行真机预览。');
    if (previewResult && previewResult.subPackageInfo) {
      console.log('\n分包大小信息:');
      console.table(previewResult.subPackageInfo);
    }
  }
}

main().catch((err) => {
  console.error('\n❌ 执行失败:', err.message || err);
  if (err.stack) {
    console.error(err.stack);
  }
  process.exit(1);
});

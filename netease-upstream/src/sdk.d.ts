/**
 * 上游 SDK 只给包入口配了类型（`interface.d.ts`），这两个深路径没有声明文件。
 * 我们只用到它们的两处：启动引导（匿名 token / xeapi 公钥）与 `/health` 报版本。
 *
 * 版本是钉死的，所以深路径不会突然变形；真要升级 SDK 时这几个声明跟着一起看一眼即可。
 */
declare module '@neteasecloudmusicapienhanced/api/generateConfig' {
  /** 注册匿名 token（写进系统临时目录）并刷新 xeapi 公钥，同时生成一个随机中国 IP。 */
  const generateConfig: () => Promise<void>;
  export = generateConfig;
}

declare module '@neteasecloudmusicapienhanced/api/package.json' {
  const pkg: { name?: string; version: string };
  export = pkg;
}

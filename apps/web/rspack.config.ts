import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from '@rspack/cli'
import { rspack } from '@rspack/core'

const dev = process.env.NODE_ENV !== 'production'
const root = path.dirname(fileURLToPath(import.meta.url))
const targets = ['chrome >= 105', 'edge >= 105', 'safari >= 16', 'firefox >= 110']

const rootPkg = JSON.parse(
  fs.readFileSync(path.resolve(root, '../../package.json'), 'utf8')
) as { version?: string }
const buildGradle = fs.readFileSync(path.resolve(root, 'android/app/build.gradle'), 'utf8')
const gradleVersionCode = Number(buildGradle.match(/versionCode\s*\(?.*?(\d+)/)?.[1] ?? '1')
const appVersion = process.env.TAVERN_VERSION_NAME || rootPkg.version || '0.1.0'
const androidVersionCode =
  Number(process.env.TAVERN_VERSION_CODE || gradleVersionCode || '1') || 1
const githubRepo = process.env.TAVERN_GITHUB_REPO || process.env.GITHUB_REPOSITORY || ''
const defaultUpdateManifestUrl =
  process.env.TAVERN_UPDATE_MANIFEST_URL ||
  (githubRepo ? `https://github.com/${githubRepo}/releases/latest/download/latest.json` : '')
const defaultUpdateMirrorUrl = process.env.TAVERN_UPDATE_MIRROR_URL || ''

const cssLoader = {
  loader: 'builtin:lightningcss-loader',
  options: { targets },
}

export default defineConfig({
  mode: dev ? 'development' : 'production',
  entry: './src/main.tsx',
  output: {
    path: path.resolve(root, 'dist'),
    publicPath: 'auto',
    filename: 'static/js/[name].[contenthash:8].js',
    chunkFilename: 'static/js/async/[name].[contenthash:8].js',
    cssFilename: 'static/css/[name].[contenthash:8].css',
    cssChunkFilename: 'static/css/async/[name].[contenthash:8].css',
    clean: true,
  },
  devtool: dev ? 'cheap-module-source-map' : false,
  resolve: {
    extensions: ['.tsx', '.ts', '.js'],
    extensionAlias: { '.js': ['.ts', '.tsx', '.js'] },
  },
  module: {
    parser: { 'css/module': { namedExports: false } },
    generator: { 'css/module': { localIdentName: '[local]-[hash:6]' } },
    rules: [
      { test: /\.module\.css$/, type: 'css/module', use: [cssLoader] },
      { test: /\.css$/, exclude: /\.module\.css$/, type: 'css', use: [cssLoader] },
      {
        test: /\.(j|t)sx?$/,
        exclude: /[\\/]node_modules[\\/]/,
        loader: 'builtin:swc-loader',
        options: {
          jsc: {
            parser: { syntax: 'typescript', tsx: true },
            transform: { react: { runtime: 'automatic', development: dev } },
            externalHelpers: true,
          },
          env: { targets },
        },
        type: 'javascript/auto',
      },
    ],
  },
  plugins: [
    new rspack.DefinePlugin({
      __APP_VERSION__: JSON.stringify(appVersion),
      __ANDROID_VERSION_CODE__: JSON.stringify(androidVersionCode),
      __DEFAULT_UPDATE_MANIFEST_URL__: JSON.stringify(defaultUpdateManifestUrl),
      __DEFAULT_UPDATE_MIRROR_URL__: JSON.stringify(defaultUpdateMirrorUrl),
    }),
    new rspack.HtmlRspackPlugin({
      template: './src/index.html',
      scriptLoading: 'defer',
    }),
    new rspack.CopyRspackPlugin({
      patterns: [{ from: path.resolve(root, 'public'), to: '.', noErrorOnMissing: true }],
    }),
  ],
  performance: { hints: false },
  devServer: {
    host: '0.0.0.0',
    port: 8091,
    allowedHosts: 'all',
    proxy: [
      {
        context: ['/api'],
        target: 'http://127.0.0.1:8797',
        changeOrigin: true,
      },
    ],
  },
})

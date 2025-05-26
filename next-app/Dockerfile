# 1. ベースイメージを選択 (Node.jsのバージョンはプロジェクトに合わせて調整してください)
FROM node:18-alpine AS base

# 2. 作業ディレクトリを設定
WORKDIR /app

# 3. 依存関係のレイヤー (キャッシュを活用するため、package.jsonとlockファイルを先にコピー)
COPY package.json ./
COPY package-lock.json ./
RUN npm install --frozen-lockfile

# 4. アプリケーションコードをコピー
COPY . .

# 5. Next.jsアプリケーションをビルド
RUN npm run build

# 6. 本番用イメージ (ビルド成果物のみをコピーしてイメージサイズを削減)
FROM node:18-alpine AS release
WORKDIR /app

COPY --from=base /app/.next ./.next
COPY --from=base /app/node_modules ./node_modules
COPY --from=base /app/package.json ./package.json

# 7. アプリケーションを実行 (package.jsonのscripts.startに合わせてください)
EXPOSE 3000
CMD ["npm", "run", "start"]

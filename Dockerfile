FROM ghcr.io/puppeteer/puppeteer:24.0.0

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY server.js ./

EXPOSE 3001
ENV PORT=3001

CMD ["node", "server.js"]

ARG NODE_VERSION=20
FROM node:${NODE_VERSION}-slim as base

LABEL fly_launch_runtime="NestJS"
WORKDIR /app

# Prisma requires OpenSSL
RUN apt-get update -y && apt-get install -y openssl

# ----------------------------
# Build Stage
# ----------------------------
FROM base as build

# Install build tools
RUN apt-get update -qq && \
    apt-get install -y python-is-python3 pkg-config build-essential openssl

# Install node modules
COPY --link package-lock.json package.json ./

# Install ALL dependencies (including devDependencies like 'prisma')
# We add --production=false to ensure dev deps are installed regardless of env defaults
RUN npm install --legacy-peer-deps --production=false

# Copy application code
COPY --link . .

# Generate prisma schema (Now uses the local prisma package, so imports work!)
RUN DATABASE_URL="postgresql://dummy:dummy@localhost:5432/dummy" npx prisma generate

# Build application
RUN npm run build

# ----------------------------
# Final Stage (Production)
# ----------------------------
FROM base

# NOW set production
ENV NODE_ENV=production

# Copy built application and dependencies
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/generated ./generated
COPY --from=build /app/prisma ./prisma 

EXPOSE 3000
CMD [ "npm", "run", "start:prod" ]
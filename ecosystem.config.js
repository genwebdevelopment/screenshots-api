module.exports = {
    apps: [
        {
            name: 'screenshot-api',
            script: 'src/server.js',
            instances: 1,
            exec_mode: 'fork',
            max_memory_restart: '1G',
            env: { NODE_ENV: 'production' },
        },
    ],
};

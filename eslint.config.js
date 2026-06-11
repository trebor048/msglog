export default [
    {
        files: ['**/*.js'],
        ignores: ['node_modules/**', 'logs/**', 'exports/**', 'content/**', 'backups/**'],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            globals: {
                process: 'readonly',
                console: 'readonly',
                Buffer: 'readonly',
                setInterval: 'readonly',
                clearInterval: 'readonly',
                setTimeout: 'readonly',
                clearTimeout: 'readonly',
                setImmediate: 'readonly',
                clearImmediate: 'readonly',
                global: 'readonly',
                URL: 'readonly'
            }
        },
        rules: {
            'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
            'no-undef': 'error'
        }
    }
];

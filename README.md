# schematic-ecs-exec (see)

Interactive CLI tool for managing AWS ECS tasks with SSO support

## Features

- 🔐 AWS SSO authentication support
- 🚀 Interactive cluster selection
- 📦 Task listing and selection
- 🐳 Container execution
- ⚙️ Profile and region management
- 💾 Persistent configuration
- 🎨 Beautiful CLI interface

## Prerequisites

- Node.js 18+
- AWS CLI v2
- AWS Session Manager Plugin
- AWS SSO configured

## Installation

```bash
npm install -g see
```

## Usage

```bash
# Configure AWS profile and region
see config set

# Show current configuration
see config show

# Clear configuration
see config cleanup

# Start interactive session
see
```

## Command Line Options

```bash
Options:
  -v, --version  Output the current version
  -h, --help     Display help for command

Commands:
  config         Manage AWS configuration
  config set     Set AWS profile and region
  config show    Show configuration path and current values
  config cleanup Remove all stored configuration
```

## Configuration

Configuration is stored in:

- macOS: `~/Users/$USER/Library/Preferences/see-nodejs`
- Linux: `~/.config/see-nodejs`
- Windows:` %APPDATA%\see-nodejs`

## Troubleshooting

- AWS CLI not found

```bash
brew install awscli

```

- Session Manager Plugin not found

```bash
brew install session-manager-plugin
```

- Invalid AWS profile

```bash
aws sso login --profile your-profile
```

## Error Messages

- `Task not found`: Ensure the ECS task is running
- `Container not found`: Task may have multiple containers
- `Invalid AWS profile`: Configure AWS profile first

## License

MIT

## Contributing

Pull requests welcome! Please read CONTRIBUTING.md for details.

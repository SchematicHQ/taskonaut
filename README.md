# schematic-ecs-exec (see)

Interactive CLI tool for exec into AWS ECS tasks (containers)

> We followed [Command Line Interface Guidelines](https://clig.dev/), An open-source guide to help you write better command-line programs, taking traditional UNIX principles and updating them for the modern day.

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
- AWS credentials configured (supports AWS SSO, access keys, etc.)

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

# Run diagnostics to check environment setup
see doctor

# Start interactive session
see
```

## Command Line Options

```bash
Usage: see [options] [command]

✨ Interactive ECS task executor

Options:
  -h, --help  display help for command

Commands:
  config      Manage configuration settings
  doctor      Run diagnostics to check your environment setup
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
  Ensure your AWS profile is configured correctly. If using AWS SSO, log in with:

```bash
aws sso login --profile your-profile
```

- AWS Credentials not configured
  Configure your AWS credentials by setting up your `~/.aws/credentials` and `~/.aws/config` files. You can use aws configure to set up access keys, or set up AWS SSO profiles.

- No clusters found
  Ensure you have access to ECS clusters in the selected AWS region and that your AWS credentials have the necessary permissions.

## Error Messages

- `Task not found`: Ensure the ECS task is running
- `Container not found`: Task may have multiple containers
- `Invalid AWS profile`: Configure AWS profile first
- `No clusters found`: Ensure you have access to ECS clusters in the selected AWS region.
- `AWS CLI is not installed`: Install AWS CLI v2.
- `Session Manager Plugin is not installed`: Install the Session Manager Plugin.
- `AWS initialization failed`: Check your AWS credentials and network connectivity.

## License

MIT

## Contributing

Pull requests welcome! Please read `CONTRIBUTING.md` for details.

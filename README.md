# taskonaut

```bash

░██████╗░█████╗░██╗░░██╗███████╗███╗░░░███╗░█████╗░████████╗██╗░█████╗░
██╔════╝██╔══██╗██║░░██║██╔════╝████╗░████║██╔══██╗╚══██╔══╝██║██╔══██╗
╚█████╗░██║░░╚═╝███████║█████╗░░██╔████╔██║███████║░░░██║░░░██║██║░░╚═╝
░╚═══██╗██║░░██╗██╔══██║██╔══╝░░██║╚██╔╝██║██╔══██║░░░██║░░░██║██║░░██╗
██████╔╝╚█████╔╝██║░░██║███████╗██║░╚═╝░██║██║░░██║░░░██║░░░██║╚█████╔╝
╚═════╝░░╚════╝░╚═╝░░╚═╝╚══════╝╚═╝░░░░░╚═╝╚═╝░░╚═╝░░░╚═╝░░░╚═╝░╚════╝░
```

![taskonaut](./.github/docs/screenshot.png)

Interactive CLI tool for exec into AWS ECS tasks (containers) - from [SchematicHQ](https://schematichq.com)

> `taskonaut` is a combination of "Task" (ECS tasks) and "Astronaut"
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

> [!WARNING]
> Make sure you have met the [Amazon ECS Exec prerequisites](https://docs.aws.amazon.com/toolkit-for-jetbrains/latest/userguide/ecs-exec.html#ecs-exec-prereq).

- Node.js 18+
- AWS CLI v2
- AWS Session Manager Plugin
- AWS credentials configured (supports AWS SSO, access keys, etc.)

## Installation

```bash
npm install -g @schematichq/taskonaut
```

## Usage

```bash
# Configure AWS profile and region
taskonaut config set

# Show current configuration
taskonaut config show

# Clear configuration
taskonaut config cleanup

# Run diagnostics to check environment setup
taskonaut doctor

# Start interactive session
taskonaut
```

## Command Line Options

```bash
Usage: taskonaut [options] [command]

✨ Interactive ECS task executor

Options:
  -h, --help  display help for command

Commands:
  config      Manage configuration settings
  doctor      Run diagnostics to check your environment setup
```

## Configuration

Configuration is stored in:

- macOS: `~/Users/$USER/Library/Preferences/taskonaut-nodejs`
- Linux: `~/.config/taskonaut-nodejs`
- Windows:`%APPDATA%\taskonaut-nodejs`

## Troubleshooting (macOS)

> [!CAUTION]
> Error messages:

- `Task not found`: Ensure the ECS task is running
- `Container not found`: Task may have zero containers
- `Invalid AWS profile`: Configure AWS profile first
- `No clusters found`: Ensure you have access to ECS clusters in the selected AWS region.
- `AWS CLI is not installed`: Install AWS CLI v2.
- `Session Manager Plugin is not installed`: Install the Session Manager Plugin.
- `AWS initialization failed`: Check your AWS credentials and network connectivity.

---

- `AWS CLI not found`

```bash
brew install awscli

```

- `Session Manager Plugin not found`

```bash
brew install session-manager-plugin
```

- `Invalid AWS profile`
  Ensure your AWS profile is configured correctly. If using AWS SSO, log in with:

```bash
aws sso login --profile your-profile
```

- `AWS Credentials not configured`
  
  Configure your AWS credentials by setting up your `~/.aws/credentials` and `~/.aws/config` files. You can use aws configure to set up access keys, or set up AWS SSO profiles.

- `No clusters found`
  
  Ensure you have access to ECS clusters in the selected AWS region and that your AWS credentials have the necessary permissions.

## License

MIT

## Contributing

Pull requests welcome! Please read `CONTRIBUTING.md` for details.

## Dependabot

We use [Dependabot](https://dependabot.com/) to keep our dependencies up to date.

## Semantic Release

We use [Semantic Release](https://semantic-release.gitbook.io/semantic-release/) to automate the release process.

## GitHub Actions

We use [GitHub Actions](https://github.com/features/actions) to run our tests and build our project.

## ToDo

- [ ] Add support for `aws-vault`

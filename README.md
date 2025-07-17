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

Interactive CLI tool for exec into AWS ECS tasks (containers) and rollback services to previous task definition revisions - from [SchematicHQ](https://schematichq.com)

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
- 📍 Navigation between clusters, tasks, and containers.
- 🔄 **ECS Service Rollback** - Rollback services to previous task definition revisions

## Prerequisites

> [!WARNING]
> Make sure you have met the [Amazon ECS Exec prerequisites](https://docs.aws.amazon.com/toolkit-for-jetbrains/latest/userguide/ecs-exec.html#ecs-exec-prereq).

- Node.js 18+
- AWS CLI v2
- AWS Session Manager Plugin
- AWS credentials configured (supports AWS SSO, access keys, etc.)

## Installation

### Recommended: Global Installation

```bash
npm install -g @schematichq/taskonaut
```

### Local Installation from Source

For development or if you prefer to install from source:

```bash
# Clone the repository
git clone https://github.com/SchematicHQ/taskonaut.git
cd taskonaut

# Install dependencies and install globally from source
npm install
npm install -g .
```

After installation, you can use `taskonaut` command globally just like the npm package installation.

> **Note**: The global npm installation method is recommended for most users as it provides automatic updates and easier management.

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

# Rollback ECS service to previous revision
taskonaut rollback

# Start interactive session
taskonaut
```

## Command Line Options

```bash
Usage: taskonaut [options] [command]

✨ Interactive ECS task executor and rollback tool

Options:
  -h, --help  display help for command

Commands:
  config      Manage configuration settings
  doctor      Run diagnostics to check your environment setup
  rollback    Rollback an ECS service to a previous task definition revision
```

## Configuration

Configuration is stored in:

- macOS: `~/Users/$USER/Library/Preferences/taskonaut-nodejs`
- Linux: `~/.config/taskonaut-nodejs`
- Windows:`%APPDATA%\taskonaut-nodejs`

## 🔄 ECS Service Rollback

The rollback feature allows you to safely revert ECS services to previous task definition revisions with an interactive, step-by-step process.

### How Rollback Works

1. **Select Cluster** - Choose from available ECS clusters
2. **Select Service** - Pick the service you want to rollback
3. **Choose Target Revision** - Select which previous revision to rollback to
4. **Preview Changes** - Review detailed comparison of current vs target:
   - Task definition revisions and creation dates
   - CPU and memory differences
   - Container image changes with tags
5. **Confirm Rollback** - Final confirmation before executing
6. **Execute & Monitor** - Rollback initiated with status tracking

### AWS Rollback Mechanism

taskonaut uses AWS ECS's native rollback capability by calling `updateService` with a previous task definition ARN. This is the same mechanism used by:
- AWS Console's "Update Service" → "Revision" selection
- AWS CLI's `aws ecs update-service --task-definition previous-revision`
- AWS SDKs and CloudFormation rollbacks

### Usage Examples

```bash
# Interactive rollback with step-by-step guidance
taskonaut rollback

# Example flow:
# 1. Select cluster: production-cluster
# 2. Select service: api-service (revision 245 → rollback available)
# 3. Choose target: Revision 243 (created 2 hours ago)
# 4. Review changes: image tags, CPU/memory differences
# 5. Confirm: "Proceed with rollback? (245 → 243)"
# 6. Execute: Rollback initiated with deployment tracking
```

### 📋 Important AWS Configuration

> [!IMPORTANT]
> **Task Definition Retention**: To enable rollback functionality, your infrastructure should retain old task definition revisions. If using Pulumi, Terraform, or similar IaC tools, configure:

**Pulumi:**
```typescript
const taskDefinition = new aws.ecs.TaskDefinition("my-task", {
    // ... other configuration
    skipDestroy: true  // Retains old revisions when updating
});
```

**Terraform:**
```hcl
resource "aws_ecs_task_definition" "my_task" {
  # ... other configuration
  skip_destroy = true
  lifecycle {
    create_before_destroy = true
  }
}
```

**Why This Matters:**
- Without `skipDestroy: true`, old task definition revisions are deleted during updates
- Rollback requires access to previous revisions (AWS keeps them for 1 year by default)
- This setting ensures your rollback history is preserved for operational safety

### Rollback Safety Features

- **Multiple Confirmations** - Prevents accidental rollbacks
- **Detailed Previews** - Shows exactly what will change
- **Container Image Tracking** - Displays image tags for easy identification  
- **Deployment Monitoring** - Provides AWS CLI commands for status tracking
- **Graceful Cancellation** - Cancel at any step without changes

## AWS authentication

### `aws sso login`

```bash
aws sso login --porfile PORFILE_NAME
taskonaut
```

### `assume`

- TBD

### `vault`

- TBD

## Troubleshooting (macOS)

> [!CAUTION]
> Error messages:

- `Task not found`: Ensure the ECS task is running
- `Container not found`: Task may have zero containers
- `Invalid AWS profile`: Configure AWS profile first
- `No clusters found`: Ensure you have access to ECS clusters in the selected AWS region.
- `No tasks found in cluster`: The selected cluster has no running tasks. taskonaut will offer options to go back and select a different cluster or check your AWS Console for running tasks.
- `AWS CLI is not installed`: Install AWS CLI v2.
- `Session Manager Plugin is not installed`: Install the Session Manager Plugin.
- `AWS initialization failed`: Check your AWS credentials and network connectivity.
- `No services found in cluster`: Ensure the cluster has running services.
- `No other revisions available for rollback`: The service only has one task definition revision, or old revisions were deleted (see `skipDestroy` configuration above).
- `Rollback failed`: Check ECS service permissions and ensure the target task definition revision still exists.
- `Unable to start command: Failed to start pty: fork/exec /bin/sh: no such file or directory`: Container doesn't have a shell (common with minimal containers like Twingate connectors, distroless images). These containers can't be accessed via exec.

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

### ECS Exec Checker from AWS

<https://github.com/aws-containers/amazon-ecs-exec-checker>

```bash
bash <( curl -Ls https://raw.githubusercontent.com/aws-containers/amazon-ecs-exec-checker/main/check-ecs-exec.sh ) <YOUR_ECS_CLUSTER_NAME> <YOUR_ECS_TASK_ID>
```

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
- [ ] Add rollback history tracking

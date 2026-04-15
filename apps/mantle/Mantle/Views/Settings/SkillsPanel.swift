import SwiftUI

// MARK: - Skills & Subagents Panel
//
// Displays registered skills and subagents fetched from agent-core.

struct SkillsPanel: View {
    let client: AgentCoreClient

    @State private var skills: [SkillMetadata] = []
    @State private var subagents: [SubagentMetadata] = []
    @State private var generalPurpose: GeneralPurposeAgent?
    @State private var isLoading = true
    @State private var errorMessage: String?

    var body: some View {
        Group {
            if isLoading {
                ProgressView("Loading skills…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let error = errorMessage {
                errorState(error)
            } else {
                contentView
            }
        }
        .task { await loadData() }
    }

    // MARK: - Content

    private var contentView: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                // Skills
                sectionHeader("Skills", count: skills.count, icon: "puzzlepiece.extension")

                if skills.isEmpty {
                    emptyHint("No skills registered")
                } else {
                    ForEach(skills) { skill in
                        skillCard(skill)
                    }
                }

                Divider()

                // Subagents
                sectionHeader("Subagents", count: subagents.count, icon: "person.2")

                if let gpa = generalPurpose, gpa.enabled {
                    gpaBadge(gpa)
                }

                if subagents.isEmpty {
                    emptyHint("No custom subagents registered")
                } else {
                    ForEach(subagents) { agent in
                        subagentCard(agent)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    // MARK: - Skill Card

    private func skillCard(_ skill: SkillMetadata) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Image(systemName: "puzzlepiece")
                    .foregroundStyle(Design.accent)
                Text(skill.name)
                    .font(.body)
                    .fontWeight(.medium)
                Spacer()
                if let license = skill.license {
                    Text(license)
                        .font(.caption2)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Design.accent.opacity(0.08), in: Capsule())
                }
            }

            Text(skill.description)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(2)

            if let tools = skill.allowedTools, !tools.isEmpty {
                HStack(spacing: 4) {
                    Image(systemName: "wrench")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                    Text(tools.joined(separator: ", "))
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                }
            }
        }
        .padding(10)
        .background(.quaternary.opacity(0.3), in: RoundedRectangle(cornerRadius: 8))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Skill: \(skill.name). \(skill.description)")
    }

    // MARK: - Subagent Card

    private func subagentCard(_ agent: SubagentMetadata) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Image(systemName: "person.badge.clock")
                    .foregroundStyle(Design.accent)
                Text(agent.name)
                    .font(.body)
                    .fontWeight(.medium)
                Spacer()
                if let model = agent.model {
                    Text(model)
                        .font(.caption2)
                        .fontDesign(.monospaced)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Design.accent.opacity(0.08), in: Capsule())
                }
            }

            Text(agent.description)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(2)

            if let skills = agent.skills, !skills.isEmpty {
                HStack(spacing: 4) {
                    Image(systemName: "puzzlepiece")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                    Text(skills.joined(separator: ", "))
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                }
            }
        }
        .padding(10)
        .background(.quaternary.opacity(0.3), in: RoundedRectangle(cornerRadius: 8))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Subagent: \(agent.name). \(agent.description)")
    }

    // MARK: - GPA Badge

    private func gpaBadge(_ gpa: GeneralPurposeAgent) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "brain")
                .foregroundStyle(Design.accent)
            VStack(alignment: .leading, spacing: 2) {
                Text(gpa.name)
                    .font(.callout)
                    .fontWeight(.medium)
                Text(gpa.description)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer()
            Text("Default")
                .font(.caption2)
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(Design.accent.opacity(0.08), in: Capsule())
        }
        .padding(10)
        .background(Design.accent.opacity(0.04), in: RoundedRectangle(cornerRadius: 8))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("General purpose agent: \(gpa.name). \(gpa.description)")
    }

    // MARK: - Helpers

    private func sectionHeader(_ title: String, count: Int, icon: String) -> some View {
        HStack(spacing: 6) {
            Image(systemName: icon)
                .foregroundStyle(.secondary)
            Text(title)
                .font(.headline)
            Text("\(count)")
                .font(.caption)
                .fontDesign(.monospaced)
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(.secondary.opacity(0.15), in: Capsule())
        }
    }

    private func emptyHint(_ text: String) -> some View {
        Text(text)
            .font(.caption)
            .foregroundStyle(.tertiary)
            .padding(.leading, 4)
    }

    private func errorState(_ message: String) -> some View {
        VStack(spacing: 12) {
            Spacer()
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 32))
                .foregroundStyle(Design.stateDanger)
            Text(message)
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Button("Retry") { Task { await loadData() } }
                .buttonStyle(.bordered)
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func loadData() async {
        isLoading = true
        errorMessage = nil

        do {
            async let skillsResult = client.skills()
            async let subagentsResult = client.subagents()

            let (s, a) = try await (skillsResult, subagentsResult)
            skills = s.skills
            subagents = a.subagents
            generalPurpose = a.generalPurposeAgent
            isLoading = false
        } catch {
            errorMessage = error.localizedDescription
            isLoading = false
        }
    }
}

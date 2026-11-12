#!/usr/bin/env python3
"""Generate the GitHub event catalog and its Feishu presentation preset.

    python3 scripts/github_catalog.py                    # write the JSON files
    python3 scripts/github_catalog.py --openapi FILE     # also check against GitHub's OpenAPI

FILE is api.github.com.json from github/rest-api-description (or @octokit/openapi).
The check fails when an event.action is missing on either side or a field path is not
in the payload schema.
"""
import argparse
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / "src/providers/github_events.json"
DESIGNS = ROOT / "src/providers/presets/github_feishu_designs.json"


# A field is (path, label, kind). Kinds: str, bool, count, join, names:<attr>, long, sha, ref.
def F(path, label, kind="str", ex=None):
    return {"path": path, "label": label, "kind": kind, "ex": ex}


# An action label starting with "=" is the complete event name.
def E(name, group, actions=None, *, subject=None, fields=(), extra=None, link=None, scope="repo", intro=None):
    """actions: {action: label}; empty means the event carries no action."""
    return {"name": name, "group": group, "actions": actions or {}, "subject": subject,
            "fields": list(fields), "extra": extra or {}, "link": link, "scope": scope, "intro": intro}


PR = ("#{pull_request.number} {pull_request.title}",
      [F("pull_request.number", "PR 编号"), F("pull_request.title", "PR 标题")])
ISSUE = ("#{issue.number} {issue.title}", [F("issue.number", "Issue 编号"), F("issue.title", "Issue 标题")])
DISCUSSION = ("#{discussion.number} {discussion.title}",
              [F("discussion.number", "讨论编号"), F("discussion.title", "讨论标题")])
PR_LINK = ("{pull_request.html_url}", "查看 Pull Request")
ISSUE_LINK = ("{issue.html_url}", "查看 Issue")
REPO_LINK = ("{repository.html_url}", "打开仓库")
LABEL = [F("label.name", "标签")]
MILESTONE = [F("milestone.title", "里程碑")]
ASSIGNEE = [F("assignee.login", "处理人")]
LOCK = "locked"

GROUPS = ["连接", "代码", "Pull Request", "Issue", "讨论", "持续集成", "部署与发布", "安全",
          "仓库", "组织与团队", "项目", "应用与赞助"]

EVENTS = {
    "ping": E("连通性测试", "连接", fields=[F("zen", "GitHub 寄语", ex="Keep it logically awesome."),
                                              F("hook_id", "Webhook ID")],
              intro="连接测试成功。Relay 已收到 GitHub 发来的测试事件。", link=REPO_LINK),
    "meta": E("Webhook", "连接", {"deleted": "已删除"}, fields=[F("hook_id", "Webhook ID"), F("hook.type", "Webhook 类型")],
              intro="当前 Webhook 已在 GitHub 中删除，之后不会再收到事件。"),

    "push": E("代码推送", "代码", subject=("{pusher.name} 推送到 {ref}", [F("pusher.name", "推送人"), F("ref", "分支或标签", "ref")]),
              fields=[F("commits", "提交数", "count"), F("forced", "强制推送", "bool"), F("after", "最新提交", "sha"),
                      F("head_commit.message", "最新提交说明", "long")],
              link=("{compare}", "查看变更")),
    "create": E("创建分支或标签", "代码", subject=("{ref_type} {ref}", [F("ref_type", "引用类型"), F("ref", "名称")]),
                link=("{repository.html_url}/tree/{ref}", "查看分支或标签")),
    "delete": E("删除分支或标签", "代码", subject=("{ref_type} {ref}", [F("ref_type", "引用类型"), F("ref", "名称")]),
                link=REPO_LINK),
    "commit_comment": E("提交评论", "代码", {"created": "已创建"},
                        subject=("提交 {comment.commit_id}", [F("comment.commit_id", "提交", "sha")]),
                        fields=[F("comment.user.login", "评论人"), F("comment.path", "文件"), F("comment.body", "评论内容", "long")],
                        link=("{comment.html_url}", "查看评论")),
    "gollum": E("Wiki 更新", "代码", fields=[F("pages", "页面", "names:title"), F("pages.0.action", "操作")],
                link=("{pages.0.html_url}", "查看页面")),

    "pull_request": E("Pull Request", "Pull Request", {
        "opened": "已创建", "closed": "已关闭或合并", "reopened": "已重新打开", "edited": "已编辑",
        "ready_for_review": "可以评审", "converted_to_draft": "已转为草稿", "synchronize": "有新提交",
        "review_requested": "请求评审", "review_request_removed": "已取消评审请求",
        "assigned": "已指派", "unassigned": "已取消指派", "labeled": "已添加标签", "unlabeled": "已移除标签",
        "milestoned": "已加入里程碑", "demilestoned": "已移出里程碑", "locked": "已锁定", "unlocked": "已解锁",
        "auto_merge_enabled": "已开启自动合并", "auto_merge_disabled": "已关闭自动合并",
        "enqueued": "已加入合并队列", "dequeued": "已移出合并队列", "stacked": "已加入堆叠"},
        subject=PR, link=PR_LINK,
        fields=[F("pull_request.user.login", "作者"), F("pull_request.head.ref", "源分支"), F("pull_request.base.ref", "目标分支")],
        extra={"opened": [F("pull_request.body", "描述", "long")],
               "closed": [F("pull_request.merged", "已合并", "bool")],
               "synchronize": [F("after", "最新提交", "sha")],
               "review_requested": [F("requested_reviewer.login", "评审人"), F("requested_team.name", "评审团队")],
               "review_request_removed": [F("requested_reviewer.login", "评审人"), F("requested_team.name", "评审团队")],
               "assigned": ASSIGNEE, "unassigned": ASSIGNEE, "labeled": LABEL, "unlabeled": LABEL,
               "milestoned": MILESTONE, "demilestoned": MILESTONE,
               "locked": [F("pull_request.active_lock_reason", "锁定原因")],
               "auto_merge_disabled": [F("reason", "原因")], "dequeued": [F("reason", "原因")],
               "stacked": [F("stack.position", "堆叠位置"), F("stack.size", "堆叠大小")]}),
    "pull_request_review": E("PR 评审", "Pull Request", {"submitted": "已提交", "edited": "已编辑", "dismissed": "已驳回"},
                             subject=PR, link=("{review.html_url}", "查看评审"),
                             fields=[F("review.user.login", "评审人"), F("review.state", "评审结果"), F("review.body", "评审意见", "long")]),
    "pull_request_review_comment": E("PR 代码评论", "Pull Request", {"created": "已创建", "edited": "已编辑", "deleted": "已删除"},
                                     subject=PR, link=("{comment.html_url}", "查看评论"),
                                     fields=[F("comment.user.login", "评论人"), F("comment.path", "文件"), F("comment.body", "评论内容", "long")]),
    "pull_request_review_thread": E("PR 评审对话", "Pull Request", {"resolved": "已解决", "unresolved": "已重新打开"},
                                    subject=PR, link=PR_LINK, fields=[F("thread.comments.0.path", "文件")]),
    "merge_group": E("合并队列", "Pull Request", {"checks_requested": "已请求检查", "destroyed": "已销毁"},
                     subject=("{merge_group.head_ref}", [F("merge_group.head_ref", "合并组分支")]),
                     fields=[F("merge_group.base_ref", "目标分支"), F("merge_group.head_sha", "提交", "sha")],
                     extra={"destroyed": [F("reason", "原因")]}, link=REPO_LINK),

    "issues": E("Issue", "Issue", {
        "opened": "已创建", "closed": "已关闭", "reopened": "已重新打开", "edited": "已编辑", "deleted": "已删除",
        "transferred": "已转移", "assigned": "已指派", "unassigned": "已取消指派", "labeled": "已添加标签",
        "unlabeled": "已移除标签", "milestoned": "已加入里程碑", "demilestoned": "已移出里程碑", "locked": "已锁定",
        "unlocked": "已解锁", "pinned": "已置顶", "unpinned": "已取消置顶", "typed": "已设置类型", "untyped": "已移除类型",
        "field_added": "已设置字段", "field_removed": "已清除字段"},
        subject=ISSUE, link=ISSUE_LINK, fields=[F("issue.user.login", "作者")],
        extra={"opened": [F("issue.labels", "标签", "names:name"), F("issue.body", "描述", "long")],
               "closed": [F("issue.state_reason", "关闭原因")],
               "transferred": [F("changes.new_repository.full_name", "新仓库")],
               "assigned": ASSIGNEE, "unassigned": ASSIGNEE, "labeled": LABEL, "unlabeled": LABEL,
               "milestoned": MILESTONE, "demilestoned": MILESTONE, "locked": [F("issue.active_lock_reason", "锁定原因")],
               "typed": [F("issue.type.name", "类型")], "untyped": [F("issue.type.name", "类型")],
               "field_added": [F("issue_field.name", "字段")], "field_removed": [F("issue_field.name", "字段")]}),
    "issue_comment": E("Issue 评论", "Issue", {"created": "已创建", "edited": "已编辑", "deleted": "已删除",
                                               "pinned": "已置顶", "unpinned": "已取消置顶"},
                       subject=ISSUE, link=("{comment.html_url}", "查看评论"),
                       fields=[F("comment.user.login", "评论人"), F("comment.body", "评论内容", "long")]),
    "sub_issues": E("子 Issue", "Issue", {"sub_issue_added": "已添加", "sub_issue_removed": "已移除",
                                         "parent_issue_added": "=父 Issue 已设置", "parent_issue_removed": "=父 Issue 已移除"},
                    subject=("#{parent_issue.number} {parent_issue.title}",
                             [F("parent_issue.number", "父 Issue 编号"), F("parent_issue.title", "父 Issue 标题")]),
                    fields=[F("sub_issue.number", "子 Issue 编号"), F("sub_issue.title", "子 Issue 标题")],
                    link=("{parent_issue.html_url}", "查看父 Issue")),
    "issue_dependencies": E("Issue 依赖", "Issue", {"blocked_by_added": "=Issue 被标记为阻塞", "blocked_by_removed": "=Issue 已解除阻塞",
                                                   "blocking_added": "=Issue 被标记为阻塞其他 Issue",
                                                   "blocking_removed": "=Issue 已不再阻塞其他 Issue"},
                            subject=("#{blocked_issue.number} {blocked_issue.title}",
                                     [F("blocked_issue.number", "被阻塞 Issue 编号"), F("blocked_issue.title", "被阻塞 Issue 标题")]),
                            fields=[F("blocking_issue.number", "阻塞 Issue 编号"), F("blocking_issue.title", "阻塞 Issue 标题")],
                            link=("{blocked_issue.html_url}", "查看 Issue")),
    "issue_relates_to": E("Issue 关联", "Issue", {"relates_to_added": "=Issue 已添加关联", "relates_to_removed": "=Issue 已移除关联"},
                          subject=ISSUE, link=ISSUE_LINK,
                          fields=[F("related_issue.number", "关联 Issue 编号"), F("related_issue.title", "关联 Issue 标题")]),
    "label": E("标签", "Issue", {"created": "已创建", "edited": "已编辑", "deleted": "已删除",
                                 "archived": "已归档", "unarchived": "已取消归档"},
               subject=("{label.name}", [F("label.name", "标签")]), fields=[F("label.description", "说明")],
               link=("{repository.html_url}/labels", "查看标签")),
    "milestone": E("里程碑", "Issue", {"created": "已创建", "opened": "已打开", "closed": "已关闭",
                                       "edited": "已编辑", "deleted": "已删除"},
                   subject=("{milestone.title}", [F("milestone.title", "里程碑")]),
                   fields=[F("milestone.due_on", "截止时间"), F("milestone.open_issues", "未完成"),
                           F("milestone.closed_issues", "已完成")],
                   link=("{milestone.html_url}", "查看里程碑")),

    "discussion": E("讨论", "讨论", {
        "created": "已创建", "edited": "已编辑", "deleted": "已删除", "answered": "已采纳回答", "unanswered": "已取消采纳",
        "category_changed": "已更换分类", "closed": "已关闭", "reopened": "已重新打开", "labeled": "已添加标签",
        "unlabeled": "已移除标签", "locked": "已锁定", "unlocked": "已解锁", "pinned": "已置顶", "unpinned": "已取消置顶",
        "transferred": "已转移"},
        subject=DISCUSSION, link=("{discussion.html_url}", "查看讨论"),
        fields=[F("discussion.category.name", "分类"), F("discussion.user.login", "作者")],
        extra={"created": [F("discussion.body", "内容", "long")],
               "answered": [F("answer.user.login", "回答者"), F("answer.body", "回答", "long")],
               "category_changed": [F("changes.category.from.name", "原分类")],
               "labeled": LABEL, "unlabeled": LABEL,
               "transferred": [F("changes.new_repository.full_name", "新仓库")]}),
    "discussion_comment": E("讨论评论", "讨论", {"created": "已创建", "edited": "已编辑", "deleted": "已删除"},
                            subject=DISCUSSION, link=("{comment.html_url}", "查看评论"),
                            fields=[F("comment.user.login", "评论人"), F("comment.body", "评论内容", "long")]),

    "workflow_run": E("工作流运行", "持续集成", {"requested": "已触发", "in_progress": "=工作流正在运行", "completed": "已结束"},
                      subject=("{workflow_run.name} #{workflow_run.run_number}",
                               [F("workflow_run.name", "工作流"), F("workflow_run.run_number", "运行编号")]),
                      fields=[F("workflow_run.head_branch", "分支"), F("workflow_run.event", "触发方式"),
                              F("workflow_run.actor.login", "触发人")],
                      extra={"requested": [F("workflow_run.display_title", "运行标题")],
                             "completed": [F("workflow_run.display_title", "运行标题"), F("workflow_run.conclusion", "结论")]},
                      link=("{workflow_run.html_url}", "查看运行")),
    "workflow_job": E("工作流任务", "持续集成", {"queued": "已排队", "waiting": "等待中", "in_progress": "运行中", "completed": "已结束"},
                      subject=("{workflow_job.workflow_name} / {workflow_job.name}",
                               [F("workflow_job.workflow_name", "工作流"), F("workflow_job.name", "任务")]),
                      fields=[F("workflow_job.head_branch", "分支"), F("workflow_job.runner_name", "Runner")],
                      extra={"completed": [F("workflow_job.conclusion", "结论")]},
                      link=("{workflow_job.html_url}", "查看任务")),
    "workflow_dispatch": E("手动触发工作流", "持续集成", subject=("{workflow}", [F("workflow", "工作流文件")]),
                           fields=[F("ref", "分支或标签", "ref")], link=("{repository.html_url}/actions", "查看 Actions")),
    "check_run": E("检查运行", "持续集成", {"created": "已创建", "completed": "已结束", "rerequested": "已请求重跑",
                                           "requested_action": "已请求操作"},
                   subject=("{check_run.name}", [F("check_run.name", "检查")]),
                   fields=[F("check_run.app.name", "应用"), F("check_run.head_sha", "提交", "sha"), F("check_run.status", "状态")],
                   extra={"completed": [F("check_run.conclusion", "结论")],
                          "requested_action": [F("requested_action.identifier", "操作")]},
                   link=("{check_run.html_url}", "查看检查")),
    "check_suite": E("检查套件", "持续集成", {"requested": "已请求", "rerequested": "已请求重跑", "completed": "已结束"},
                     subject=("{check_suite.app.name}", [F("check_suite.app.name", "应用")]),
                     fields=[F("check_suite.head_branch", "分支"), F("check_suite.head_sha", "提交", "sha"),
                             F("check_suite.status", "状态")],
                     extra={"completed": [F("check_suite.conclusion", "结论")]},
                     link=("{repository.html_url}/commit/{check_suite.head_sha}", "查看提交")),
    "status": E("提交状态", "持续集成", subject=("{context}", [F("context", "检查项")]),
                fields=[F("state", "状态"), F("sha", "提交", "sha"), F("branches", "分支", "names:name"),
                        F("description", "说明", "long")],
                link=("{target_url}", "查看详情")),

    "deployment": E("部署", "部署与发布", {"created": "已创建"},
                    subject=("{deployment.environment}", [F("deployment.environment", "环境")]),
                    fields=[F("deployment.ref", "分支或标签"), F("deployment.creator.login", "创建人"),
                            F("deployment.description", "说明", "long")],
                    link=("{repository.html_url}/deployments", "查看部署")),
    "deployment_status": E("部署状态", "部署与发布", {"created": "已更新"},
                           subject=("{deployment.environment}", [F("deployment.environment", "环境")]),
                           fields=[F("deployment_status.state", "状态"), F("deployment.ref", "分支或标签"),
                                   F("deployment_status.description", "说明", "long")],
                           link=("{deployment_status.target_url}", "查看部署")),
    "deployment_review": E("部署审批", "部署与发布", {"requested": "=部署等待审批", "approved": "已通过", "rejected": "已拒绝"},
                           subject=("{workflow_run.name}", [F("workflow_run.name", "工作流")]),
                           fields=[F("workflow_run.head_branch", "分支")],
                           extra={"requested": [F("environment", "环境"), F("requestor.login", "申请人")],
                                  "approved": [F("workflow_job_runs.0.environment", "环境"), F("approver.login", "审批人"), F("comment", "审批意见", "long")],
                                  "rejected": [F("workflow_job_runs.0.environment", "环境"), F("approver.login", "审批人"), F("comment", "审批意见", "long")]},
                           link=("{workflow_run.html_url}", "查看运行")),
    "deployment_protection_rule": E("部署保护规则", "部署与发布", {"requested": "=部署等待保护规则判定"},
                                    subject=("{environment}", [F("environment", "环境")]),
                                    fields=[F("event", "触发方式"), F("deployment.ref", "分支或标签")],
                                    link=("{repository.html_url}/deployments", "查看部署")),
    "release": E("Release", "部署与发布", {"published": "已发布", "released": "已正式发布", "prereleased": "已预发布",
                                           "created": "已创建", "edited": "已编辑", "deleted": "已删除", "unpublished": "已撤回"},
                 subject=("{release.name}", [F("release.name", "版本名称")]),
                 fields=[F("release.tag_name", "标签"), F("release.author.login", "发布人"),
                         F("release.prerelease", "预发布", "bool"), F("release.body", "更新说明", "long")],
                 link=("{release.html_url}", "查看 Release")),
    "package": E("软件包", "部署与发布", {"published": "已发布", "updated": "已更新"},
                 subject=("{package.name}", [F("package.name", "软件包")]),
                 fields=[F("package.package_type", "类型"), F("package.package_version.version", "版本")],
                 link=("{package.html_url}", "查看软件包")),
    "registry_package": E("Registry 软件包", "部署与发布", {"published": "已发布", "updated": "已更新"},
                          subject=("{registry_package.name}", [F("registry_package.name", "软件包")]),
                          fields=[F("registry_package.package_type", "类型"),
                                  F("registry_package.package_version.version", "版本")],
                          link=("{registry_package.html_url}", "查看软件包")),
    "page_build": E("Pages 构建", "部署与发布", subject=("{build.status}", [F("build.status", "构建状态")]),
                    fields=[F("build.pusher.login", "推送人"), F("build.commit", "提交", "sha"),
                            F("build.error.message", "错误", "long")],
                    link=("{repository.html_url}/settings/pages", "查看 Pages")),

    "code_scanning_alert": E("代码扫描告警", "安全", {
        "created": "已产生", "fixed": "已修复", "closed_by_user": "已手动关闭", "reopened": "已重新打开",
        "reopened_by_user": "已手动重新打开", "appeared_in_branch": "出现在新分支", "updated_assignment": "处理人已变更"},
        subject=("#{alert.number} {alert.rule.description}",
                 [F("alert.number", "告警编号"), F("alert.rule.description", "规则")]),
        fields=[F("alert.rule.severity", "严重程度"), F("alert.tool.name", "扫描工具"),
                F("alert.most_recent_instance.ref", "分支或标签", "ref")],
        link=("{alert.html_url}", "查看告警")),
    "dependabot_alert": E("Dependabot 告警", "安全", {
        "created": "已产生", "fixed": "已修复", "dismissed": "已忽略", "reopened": "已重新打开", "reintroduced": "再次出现",
        "auto_dismissed": "已自动忽略", "auto_reopened": "已自动重新打开", "assignees_changed": "处理人已变更"},
        subject=("#{alert.number} {alert.security_advisory.summary}",
                 [F("alert.number", "告警编号"), F("alert.security_advisory.summary", "漏洞")]),
        fields=[F("alert.security_vulnerability.severity", "严重程度"), F("alert.dependency.package.name", "依赖包"),
                F("alert.dependency.manifest_path", "清单文件"), F("alert.security_advisory.ghsa_id", "GHSA")],
        link=("{alert.html_url}", "查看告警")),
    "secret_scanning_alert": E("密钥扫描告警", "安全", {
        "created": "已产生", "resolved": "已解决", "reopened": "已重新打开", "publicly_leaked": "已公开泄露",
        "validated": "有效性已验证", "assigned": "已指派", "unassigned": "已取消指派",
        "metadata_created": "元数据已创建", "metadata_removed": "元数据已移除"},
        subject=("#{alert.number} {alert.secret_type_display_name}",
                 [F("alert.number", "告警编号"), F("alert.secret_type_display_name", "密钥类型")]),
        fields=[F("alert.validity", "有效性"), F("alert.resolution", "处理结果")],
        link=("{alert.html_url}", "查看告警")),
    "secret_scanning_alert_location": E("密钥泄露位置", "安全", {"created": "已发现"},
                                        subject=("#{alert.number} {alert.secret_type_display_name}",
                                                 [F("alert.number", "告警编号"), F("alert.secret_type_display_name", "密钥类型")]),
                                        fields=[F("location.type", "位置类型"), F("location.details.path", "文件")],
                                        link=("{alert.html_url}", "查看告警")),
    "secret_scanning_scan": E("密钥扫描", "安全", {"completed": "已完成"},
                              subject=("{type}", [F("type", "扫描类型")]),
                              fields=[F("source", "扫描范围"), F("completed_at", "完成时间")],
                              link=("{repository.html_url}/security/secret-scanning", "查看密钥扫描")),
    "repository_advisory": E("仓库安全公告", "安全", {"published": "已发布", "reported": "=收到安全漏洞报告"},
                             subject=("{repository_advisory.summary}", [F("repository_advisory.summary", "公告")]),
                             fields=[F("repository_advisory.ghsa_id", "GHSA"), F("repository_advisory.severity", "严重程度")],
                             link=("{repository_advisory.html_url}", "查看公告")),
    "repository_vulnerability_alert": E("依赖漏洞告警（旧版）", "安全", {
        "create": "已产生", "dismiss": "已忽略", "reopen": "已重新打开", "resolve": "已解决"},
        subject=("{alert.affected_package_name}", [F("alert.affected_package_name", "依赖包")]),
        fields=[F("alert.severity", "严重程度"), F("alert.affected_range", "影响范围"), F("alert.fixed_in", "修复版本"),
                F("alert.external_identifier", "漏洞编号")],
        link=("{repository.html_url}/security", "查看安全")),
    "security_advisory": E("GitHub 安全公告", "安全", {"published": "已发布", "updated": "已更新", "withdrawn": "已撤回"},
                           subject=("{security_advisory.summary}", [F("security_advisory.summary", "公告")]),
                           fields=[F("security_advisory.ghsa_id", "GHSA"), F("security_advisory.severity", "严重程度")],
                           scope="none", link=("https://github.com/advisories/{security_advisory.ghsa_id}", "查看公告")),
    "security_and_analysis": E("安全功能设置", "安全", intro="仓库的代码安全与分析功能设置已变更。",
                               link=("{repository.html_url}/settings/security_analysis", "查看设置")),

    "repository": E("仓库", "仓库", {
        "created": "已创建", "deleted": "已删除", "archived": "已归档", "unarchived": "已取消归档", "edited": "已编辑",
        "renamed": "已重命名", "transferred": "已转移", "publicized": "已公开", "privatized": "已设为私有"},
        fields=[F("repository.visibility", "可见性"), F("repository.description", "说明", "long")],
        extra={"renamed": [F("changes.repository.name.from", "原名称")],
               "transferred": [F("changes.owner.from.user.login", "原所有者"),
                               F("changes.owner.from.organization.login", "原组织")]},
        link=REPO_LINK),
    "branch_protection_rule": E("分支保护规则", "仓库", {"created": "已创建", "edited": "已编辑", "deleted": "已删除"},
                                subject=("{rule.name}", [F("rule.name", "分支规则")]),
                                link=("{repository.html_url}/settings/branches", "查看分支设置")),
    "branch_protection_configuration": E("分支保护", "仓库", {"enabled": "已启用", "disabled": "已停用"},
                                         link=("{repository.html_url}/settings/branches", "查看分支设置")),
    "repository_ruleset": E("仓库规则集", "仓库", {"created": "已创建", "edited": "已编辑", "deleted": "已删除"},
                            subject=("{repository_ruleset.name}", [F("repository_ruleset.name", "规则集")]),
                            fields=[F("repository_ruleset.target", "作用对象"), F("repository_ruleset.enforcement", "执行状态")],
                            link=("{repository.html_url}/rules", "查看规则集")),
    "deploy_key": E("部署密钥", "仓库", {"created": "已添加", "deleted": "已删除"},
                    subject=("{key.title}", [F("key.title", "密钥名称")]), fields=[F("key.read_only", "只读", "bool")],
                    link=("{repository.html_url}/settings/keys", "查看部署密钥")),
    "custom_property_values": E("仓库自定义属性", "仓库", {"updated": "已更新"},
                                fields=[F("new_property_values", "变更属性", "names:property_name")], link=REPO_LINK),
    "public": E("仓库公开", "仓库", intro="仓库已从私有改为公开。", link=REPO_LINK),
    "repository_import": E("仓库导入", "仓库", subject=("{status}", [F("status", "导入状态")]), link=REPO_LINK),
    "repository_dispatch": E("仓库自定义事件", "仓库", subject=("{action}", [F("action", "事件类型", ex="on-demand-test")]),
                             fields=[F("branch", "分支")], link=("{repository.html_url}/actions", "查看 Actions")),
    "star": E("Star", "仓库", {"created": "=新增 Star", "deleted": "=取消 Star"},
              fields=[F("repository.stargazers_count", "Star 总数")], link=REPO_LINK),
    "watch": E("关注", "仓库", {"started": "=新增关注"}, fields=[F("repository.watchers_count", "关注总数")], link=REPO_LINK),
    "fork": E("仓库被 Fork", "仓库", subject=("{forkee.full_name}", [F("forkee.full_name", "新仓库")]),
              link=("{forkee.html_url}", "查看 Fork")),
    "member": E("仓库协作者", "仓库", {"added": "已添加", "edited": "权限已变更", "removed": "已移除"},
                subject=("{member.login}", [F("member.login", "协作者")]), extra={"added": [F("changes.permission.to", "权限")]},
                link=("{repository.html_url}/settings/access", "查看协作者")),
    "team_add": E("团队加入仓库", "仓库", subject=("{team.name}", [F("team.name", "团队")]), link=("{team.html_url}", "查看团队")),

    "organization": E("组织", "组织与团队", {
        "member_added": "成员已加入", "member_removed": "成员已移除", "member_invited": "已邀请成员",
        "renamed": "已重命名", "deleted": "已删除"},
        scope="org",
        extra={"member_added": [F("membership.user.login", "成员"), F("membership.role", "角色")],
               "member_removed": [F("membership.user.login", "成员"), F("membership.role", "角色")],
               "member_invited": [F("invitation.login", "被邀请人"), F("invitation.email", "邮箱")],
               "renamed": [F("changes.login.from", "原名称")]},
        link=("https://github.com/{organization.login}", "查看组织")),
    "membership": E("团队成员", "组织与团队", {"added": "已加入", "removed": "已移除"}, scope="org",
                    subject=("{member.login}", [F("member.login", "成员")]), fields=[F("team.name", "团队")],
                    link=("{team.html_url}", "查看团队")),
    "team": E("团队", "组织与团队", {"created": "已创建", "deleted": "已删除", "edited": "已编辑",
                                    "added_to_repository": "已加入仓库", "removed_from_repository": "已移出仓库"},
              scope="org", subject=("{team.name}", [F("team.name", "团队")]),
              fields=[F("team.privacy", "可见性"), F("repository.full_name", "仓库")], link=("{team.html_url}", "查看团队")),
    "org_block": E("组织封禁", "组织与团队", {"blocked": "=组织已封禁用户", "unblocked": "=组织已解封用户"}, scope="org",
                   subject=("{blocked_user.login}", [F("blocked_user.login", "用户")]),
                   link=("{blocked_user.html_url}", "查看用户")),
    "custom_property": E("组织自定义属性", "组织与团队", {"created": "已创建", "updated": "已更新", "deleted": "已删除",
                                                          "promote_to_enterprise": "已提升到企业"},
                         scope="org", subject=("{definition.property_name}", [F("definition.property_name", "属性")]),
                         extra={a: [F("definition.value_type", "值类型")]
                                for a in ("created", "updated", "promote_to_enterprise")}),
    "personal_access_token_request": E("访问令牌申请", "组织与团队", {"created": "=收到访问令牌申请", "approved": "已批准",
                                                                       "denied": "已拒绝", "cancelled": "已取消"},
                                       scope="org", subject=("{personal_access_token_request.owner.login}",
                                                             [F("personal_access_token_request.owner.login", "申请人")]),
                                       fields=[F("personal_access_token_request.repository_selection", "仓库范围"),
                                               F("personal_access_token_request.token_expires_at", "过期时间")]),

    "project": E("项目（经典）", "项目", {"created": "已创建", "edited": "已编辑", "closed": "已关闭",
                                          "reopened": "已重新打开", "deleted": "已删除"},
                 subject=("{project.name}", [F("project.name", "项目")]), link=("{project.html_url}", "查看项目")),
    "project_card": E("项目卡片（经典）", "项目", {"created": "已创建", "edited": "已编辑", "moved": "已移动",
                                                  "converted": "已转为 Issue", "deleted": "已删除"},
                      fields=[F("project_card.note", "卡片内容", "long")]),
    "project_column": E("项目列（经典）", "项目", {"created": "已创建", "edited": "已编辑", "moved": "已移动", "deleted": "已删除"},
                        subject=("{project_column.name}", [F("project_column.name", "列")])),
    "projects_v2": E("项目", "项目", {"created": "已创建", "edited": "已编辑", "closed": "已关闭",
                                      "reopened": "已重新打开", "deleted": "已删除"}, scope="org",
                     subject=("{projects_v2.title}", [F("projects_v2.title", "项目")]),
                     fields=[F("projects_v2.short_description", "说明", "long")]),
    "projects_v2_item": E("项目条目", "项目", {"created": "已添加", "edited": "已编辑", "archived": "已归档",
                                              "restored": "已恢复", "converted": "已转为 Issue", "reordered": "已调整顺序",
                                              "deleted": "已删除"}, scope="org",
                          fields=[F("projects_v2_item.content_type", "条目类型")]),
    "projects_v2_status_update": E("项目状态更新", "项目", {"created": "已发布", "edited": "已编辑", "deleted": "已删除"},
                                   scope="org",
                                   subject=("{projects_v2_status_update.status}", [F("projects_v2_status_update.status", "状态")]),
                                   fields=[F("projects_v2_status_update.target_date", "目标日期"),
                                           F("projects_v2_status_update.body", "内容", "long")]),

    "installation": E("GitHub App", "应用与赞助", {"created": "已安装", "deleted": "已卸载", "suspend": "已暂停",
                                                       "unsuspend": "已恢复", "new_permissions_accepted": "已接受新权限"},
                      scope="none", subject=("{installation.account.login}", [F("installation.account.login", "账号")]),
                      fields=[F("installation.app_slug", "应用"), F("installation.repository_selection", "仓库范围"),
                              F("sender.login", "操作人")],
                      link=("{installation.html_url}", "查看安装")),
    "installation_repositories": E("GitHub App 授权仓库", "应用与赞助", {"added": "已添加", "removed": "已移除"},
                                   scope="none", subject=("{installation.account.login}",
                                                          [F("installation.account.login", "账号")]),
                                   fields=[F("repositories_added", "新增仓库", "names:full_name"),
                                           F("repositories_removed", "移除仓库", "names:full_name"),
                                           F("sender.login", "操作人")],
                                   link=("{installation.html_url}", "查看安装")),
    "installation_target": E("GitHub App 安装账号", "应用与赞助", {"renamed": "已重命名"}, scope="none",
                             subject=("{account.login}", [F("account.login", "账号")]),
                             fields=[F("changes.login.from", "原名称"), F("target_type", "账号类型")]),
    "github_app_authorization": E("GitHub App 授权", "应用与赞助", {"revoked": "已撤销"}, scope="none",
                                  subject=("{sender.login}", [F("sender.login", "用户")])),
    "marketplace_purchase": E("Marketplace 订阅", "应用与赞助", {
        "purchased": "已购买", "changed": "已变更", "cancelled": "已取消", "pending_change": "待变更",
        "pending_change_cancelled": "已取消待变更"}, scope="none",
        subject=("{marketplace_purchase.account.login}", [F("marketplace_purchase.account.login", "账号")]),
        fields=[F("marketplace_purchase.plan.name", "套餐"), F("marketplace_purchase.billing_cycle", "计费周期"),
                F("effective_date", "生效时间")]),
    "sponsorship": E("赞助", "应用与赞助", {
        "created": "=新增赞助", "edited": "已编辑", "cancelled": "已取消", "pending_cancellation": "即将取消",
        "tier_changed": "档位已变更", "pending_tier_change": "档位即将变更"}, scope="none",
        subject=("{sponsorship.sponsor.login}", [F("sponsorship.sponsor.login", "赞助人")]),
        fields=[F("sponsorship.sponsorable.login", "被赞助人"), F("sponsorship.tier.name", "档位")],
        extra={"tier_changed": [F("changes.tier.from.name", "原档位")],
               "pending_tier_change": [F("changes.tier.from.name", "原档位"), F("effective_date", "生效时间")],
               "pending_cancellation": [F("effective_date", "生效时间")]},
        link=("{sponsorship.sponsor.html_url}", "查看赞助人")),
}

COMMON = {
    "repo": [F("repository.full_name", "仓库"), F("sender.login", "操作人")],
    "org": [F("organization.login", "组织"), F("sender.login", "操作人")],
    "none": [],
}

# Accents follow the meaning of the action, then fall back to blue.
ACCENTS = {
    "green": {"opened", "created", "published", "released", "approved", "fixed", "resolved", "answered", "added",
              "purchased", "enabled", "started", "unsuspend", "ready_for_review", "reopened", "member_added",
              "added_to_repository", "relates_to_added", "sub_issue_added", "parent_issue_added", "restored"},
    "red": {"deleted", "denied", "rejected", "withdrawn", "revoked", "blocked", "suspend", "publicly_leaked",
            "dismissed", "disabled", "reintroduced", "destroyed"},
    "orange": {"review_requested", "requested", "checks_requested", "waiting", "queued", "pending_change",
               "pending_cancellation", "pending_tier_change", "transferred", "locked", "member_invited",
               "requested_action", "rerequested", "reported"},
    "grey": {"closed", "unlocked", "unlabeled", "unassigned", "unpinned", "demilestoned", "converted_to_draft",
             "archived", "unarchived", "removed", "member_removed", "removed_from_repository", "unanswered",
             "auto_dismissed", "unpublished", "unblocked", "untyped", "field_removed", "cancelled",
             "pending_change_cancelled", "auto_merge_disabled", "dequeued", "review_request_removed",
             "sub_issue_removed", "parent_issue_removed", "blocked_by_removed", "blocking_removed", "relates_to_removed"},
}
EVENT_ACCENTS = {"ping": "green", "pull_request.closed": "purple", "push": "blue",
                 "code_scanning_alert.created": "red", "dependabot_alert.created": "red",
                 "secret_scanning_alert.created": "red", "secret_scanning_alert_location.created": "red",
                 "repository_vulnerability_alert.create": "red", "security_advisory.published": "red",
                 "repository_advisory.reported": "orange"}

EXAMPLES = {
    "login": "octocat", "full_name": "octo-org/hello-world", "html_url": "https://github.com/octo-org/hello-world",
    "number": 42, "run_number": 128, "ref": "refs/heads/main", "head_ref": "gh-readonly-queue/main/pr-42",
    "base_ref": "refs/heads/main", "head_branch": "main", "state": "success", "status": "completed",
    "conclusion": "success", "severity": "high", "ghsa_id": "GHSA-abcd-1234-efgh", "environment": "production",
    "tag_name": "v1.4.0", "visibility": "public", "role": "member", "privacy": "closed", "ref_type": "branch",
    "event": "push", "workflow": ".github/workflows/deploy.yml", "path": "src/main.rs", "context": "ci/build",
    "type": "backfill", "source": "git", "validity": "active", "resolution": "revoked", "package_type": "CONTAINER",
    "version": "1.4.0", "position": 2, "size": 3, "stargazers_count": 1024, "watchers_count": 256,
    "open_issues": 3, "closed_issues": 9, "zen": "Keep it logically awesome.", "hook_id": 109948940,
    "target": "branch", "enforcement": "active", "repository_selection": "selected", "billing_cycle": "monthly",
    "value_type": "string", "content_type": "Issue", "target_type": "Organization", "secret_type_display_name": "GitHub Personal Access Token",
}
# Exact paths win over the per-key defaults above.
PATH_EXAMPLES = {
    "pull_request.title": "修复 Safari 下登录页布局错位", "issue.title": "导出 CSV 时中文乱码",
    "parent_issue.title": "支持多语言导出", "sub_issue.title": "导出 CSV 时中文乱码",
    "blocked_issue.title": "发布 1.4.0", "blocking_issue.title": "修复 Safari 下登录页布局错位",
    "related_issue.title": "导出 Excel 时中文乱码", "discussion.title": "1.4.0 的发布计划",
    "pull_request.head.ref": "fix/safari-login", "pull_request.base.ref": "main",
    "head_commit.message": "fix: 修复 Safari 下登录页布局错位", "pusher.name": "octocat",
    "workflow_run.name": "CI", "workflow_run.display_title": "fix: 修复 Safari 下登录页布局错位",
    "workflow_job.workflow_name": "CI", "workflow_job.name": "build", "workflow_job.runner_name": "ubuntu-latest",
    "check_run.name": "build", "check_run.app.name": "GitHub Actions", "check_suite.app.name": "GitHub Actions",
    "release.name": "v1.4.0", "release.body": "- 新增 GitHub 事件转发\n- 修复若干问题",
    "package.name": "hello-world", "registry_package.name": "hello-world", "label.name": "bug",
    "label.description": "功能异常", "milestone.title": "v1.4.0", "team.name": "backend",
    "discussion.category.name": "公告", "changes.category.from.name": "问答", "rule.name": "main",
    "repository_ruleset.name": "保护主分支", "key.title": "deploy@ci", "alert.rule.description": "SQL 注入风险",
    "alert.security_advisory.summary": "lodash 原型污染", "alert.dependency.package.name": "lodash",
    "alert.dependency.manifest_path": "package-lock.json", "alert.tool.name": "CodeQL",
    "alert.affected_package_name": "lodash", "alert.affected_range": "< 4.17.21", "alert.fixed_in": "4.17.21",
    "alert.external_identifier": "CVE-2021-23337", "repository_advisory.summary": "未授权访问管理接口",
    "security_advisory.summary": "lodash 原型污染", "location.details.path": "config/.env",
    "location.type": "commit", "deployment.ref": "main", "deployment.description": "发布 v1.4.0",
    "deployment_status.description": "部署成功", "description": "构建通过", "build.status": "built",
    "comment.path": "src/main.rs", "project.name": "路线图", "project_column.name": "进行中",
    "projects_v2.title": "路线图", "projects_v2_status_update.status": "ON_TRACK",
    "installation.app_slug": "relay-bot", "marketplace_purchase.plan.name": "Pro",
    "sponsorship.tier.name": "$5 / 月", "changes.tier.from.name": "$1 / 月", "definition.property_name": "team",
    "issue_field.name": "优先级", "issue.state_reason": "completed", "issue.type.name": "Bug",
    "requested_team.name": "backend", "invitation.email": "octocat@example.com", "reason": "merge",
    "changes.repository.name.from": "hello", "changes.login.from": "octo-old", "branch": "main",
    "compare": "https://github.com/octo-org/hello-world/compare/9a1f2c3...6dcb09b", "organization.login": "octo-org",
    "pull_request.html_url": "https://github.com/octo-org/hello-world/pull/42",
    "issue.html_url": "https://github.com/octo-org/hello-world/issues/42",
    "workflow_run.html_url": "https://github.com/octo-org/hello-world/actions/runs/128",
    "release.html_url": "https://github.com/octo-org/hello-world/releases/tag/v1.4.0",
    "discussion.html_url": "https://github.com/octo-org/hello-world/discussions/42",
    "personal_access_token_request.owner.login": "octocat", "membership.user.login": "octocat",
    "pull_request.active_lock_reason": "resolved", "issue.active_lock_reason": "resolved",
}
LABEL_EXAMPLES = {"bool": True, "count": [{"id": "6dcb09b"}, {"id": "9a1f2c3"}]}
SHA = "6dcb09b5b57875f334f61aebed695e2e4193db5e"


def raw(path):
    return '(event.raw | field("/%s"))' % path.replace(".", "/")


def expression(field):
    r, kind = raw(field["path"]), field["kind"]
    if kind == "bool":
        return f'("是" if {r} else "否") if {r} is not none else ""'
    if kind == "count":
        return f"{r} | default([], true) | length"
    if kind == "join":
        return f'{r} | default([], true) | join("、")'
    if kind.startswith("names:"):
        return f'{r} | default([], true) | map(attribute="{kind[6:]}") | join("、")'
    if kind == "long":
        return f'({r} | default("", true))[:500]'
    if kind == "sha":
        return f'({r} | default("", true))[:7]'
    if kind == "ref":
        return f'{r} | default("", true) | replace("refs/heads/", "") | replace("refs/tags/", "")'
    return f'{r} | default("", true)'


def example(field):
    if field["ex"] is not None:
        return field["ex"]
    if field["path"] in PATH_EXAMPLES:
        return PATH_EXAMPLES[field["path"]]
    last = field["path"].split(".")[-1]
    if field["kind"] == "sha" or last in ("sha", "commit_id", "after", "head_sha", "commit"):
        return SHA
    if field["kind"] in LABEL_EXAMPLES:
        return LABEL_EXAMPLES[field["kind"]]
    if field["kind"].startswith("names:"):
        attr = field["kind"][6:]
        return [{attr: v} for v in (["octo-org/hello-world", "octo-org/docs"] if attr == "full_name" else ["示例一", "示例二"])]
    if last in EXAMPLES:
        return EXAMPLES[last]
    if last.endswith("_url"):
        return "https://github.com/octo-org/hello-world"
    if last.endswith("_at") or last in ("due_on", "effective_date", "target_date"):
        return "2026-11-12T08:30:00Z"
    if field["kind"] == "long":
        return f"这里是{field['label']}的示例。"
    return f"示例{field['label']}"


def assign(target, path, value):
    parts = path.split(".")
    for i, part in enumerate(parts):
        last = i == len(parts) - 1
        nxt = None if last else ([] if parts[i + 1].isdigit() else {})
        if part.isdigit():
            index = int(part)
            while len(target) <= index:
                target.append({} if nxt is None or isinstance(nxt, dict) else [])
            if last:
                target[index] = value
            else:
                target = target[index]
        else:
            if last:
                target[part] = value
            else:
                target = target.setdefault(part, nxt)


def placeholders(text):
    return re.findall(r"\{([a-z0-9_.]+)\}", text)


def fill(text, tokens):
    return re.sub(r"\{([a-z0-9_.]+)\}", lambda m: "{{ %s }}" % tokens[m.group(1)], text)


def block_id(path):
    return re.sub(r"[^a-zA-Z0-9]+", "_", path).strip("_")


LINK_LABEL = "链接地址"


def build_entry(event, action, spec, label, order):
    key = f"{event}.{action}" if action else event
    # Latin names read better with a space before Chinese action labels.
    gap = " " if action and re.search(r"[A-Za-z0-9]$", spec["name"]) else ""
    name = f"{spec['name']}{gap}{label}" if action else spec["name"]
    if action and label.startswith("="):
        name = label[1:]
    subject_text, subject_fields = spec["subject"] or ("", [])
    fields = []
    for f in subject_fields + COMMON[spec["scope"]] + spec["fields"] + spec["extra"].get(action, []):
        if all(f["path"] != g["path"] for g in fields):
            fields.append(f)
    link_url, link_text = spec["link"] or (None, None)
    link_paths = placeholders(link_url) if link_url else []
    # Fields referenced only by the link are still variables and sample values.
    for path in link_paths:
        if all(path != g["path"] for g in fields):
            fields.append(F(path, LINK_LABEL, "ref" if path == "ref" else "str"))
    exprs = {f["path"]: expression(f) for f in fields}
    description = spec["intro"] or f"{name}。"
    blocks = []
    if subject_text:
        blocks.append({"id": "subject", "kind": "text", "label": "", "text": fill(subject_text, exprs)})
    elif spec["intro"]:
        blocks.append({"id": "intro", "kind": "text", "label": "", "text": spec["intro"]})
    styles = {}
    shown = {f["path"] for f in subject_fields}
    for f in fields:
        if f["path"] in shown or f["label"] == LINK_LABEL:
            continue
        bid = block_id(f["path"])
        blocks.append({"id": bid, "kind": "text", "label": f["label"], "text":
                       "{%% if %s is not none %%}{{ %s }}{%% endif %%}" % (raw(f["path"]), exprs[f["path"]])})
        if f["kind"] == "long":
            styles[bid] = "text"
    if subject_text and spec["intro"]:
        blocks.append({"id": "intro", "kind": "text", "label": "", "text": spec["intro"]})
        styles["intro"] = "note"
    if link_url:
        guard = " and ".join(f"{raw(p)}" for p in link_paths)
        blocks.append({"id": "open", "kind": "link", "label": "",
                       "text": "{%% if %s %%}%s{%% endif %%}" % (guard, link_text), "url": fill(link_url, exprs)})
    sample = {}
    if action:
        sample["action"] = action
    for f in fields:
        value = action if f["path"] == "action" and action else example(f)
        assign(sample, f["path"], value)
    accent = EVENT_ACCENTS.get(key) or EVENT_ACCENTS.get(event)
    if not accent:
        accent = next((c for c, actions in ACCENTS.items() if action in actions), "blue")
    entry = {
        "name": name,
        "group": spec["group"],
        "order": order,
        "description": description,
        "fields": [{"path": f["path"], "label": f["label"], "expression": exprs[f["path"]], "optional": True} for f in fields],
        "sample": sample,
        "sample_headers": {"x-github-event": event, "x-github-delivery": f"preview-{key}"},
        "content_template": {"title": "{{ event.source_name }} · %s" % name, "blocks": blocks},
    }
    design = {"presentation": {"style": "card", "accent": accent, "block_styles": styles}}
    return key, entry, design


def build():
    catalog, designs, order = {}, {}, 0
    for group in GROUPS:
        for event, spec in EVENTS.items():
            if spec["group"] != group:
                continue
            for action, label in (spec["actions"].items() or [(None, None)]):
                key, entry, design = build_entry(event, action, spec, label, order)
                catalog[key], designs[key] = entry, design
                order += 1
    assert set(e["group"] for e in EVENTS.values()) <= set(GROUPS)
    return catalog, designs


def check(catalog, openapi):
    spec = json.loads(Path(openapi).read_text())
    schemas = spec["components"]["schemas"]

    def resolve(node):
        while "$ref" in node:
            node = schemas[node["$ref"].split("/")[-1]]
        return node

    def variants(node):
        node = resolve(node)
        out = [node]
        for key in ("allOf", "oneOf", "anyOf"):
            for child in node.get(key, []):
                out.extend(variants(child))
        return out

    def has(node, parts):
        if not parts:
            return True
        for v in variants(node):
            if parts[0].isdigit() and "items" in v and has(v["items"], parts[1:]):
                return True
            if parts[0] in v.get("properties", {}) and has(v["properties"][parts[0]], parts[1:]):
                return True
        return False

    official, errors = {}, []
    for op in (item["post"] for item in spec["x-webhooks"].values()):
        event = op["x-github"]["subcategory"].replace("-", "_")
        schema = resolve(op["requestBody"]["content"]["application/json"]["schema"])
        actions = [v["properties"]["action"] for v in variants(schema) if "action" in v.get("properties", {})]
        enum = next((resolve(a)["enum"] for a in actions if "enum" in resolve(a)), None)
        key = f"{event}.{enum[0]}" if enum else event
        official.setdefault(key, []).append(schema)
    for key in sorted(set(official) ^ set(catalog)):
        errors.append(f"{'missing' if key in official else 'unknown'} event: {key}")
    for key, entry in catalog.items():
        for field in entry["fields"]:
            parts = field["path"].split(".")
            if key in official and not any(has(s, parts) for s in official[key]):
                errors.append(f"{key}: no field {field['path']}")
    return errors


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--openapi", help="api.github.com.json to check coverage against")
    args = parser.parse_args()
    catalog, designs = build()
    if args.openapi:
        errors = check(catalog, args.openapi)
        print("\n".join(errors) or f"OpenAPI check passed: {len(catalog)} events")
        if errors:
            raise SystemExit(1)
    CATALOG.write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + "\n")
    DESIGNS.write_text(json.dumps([{
        "id": "github-feishu", "name": "GitHub × 飞书",
        "description": "覆盖所有 GitHub 事件的飞书卡片预设，按事件语义设置卡片颜色与字段布局。",
        "source_provider": "github", "destination_provider": "feishu", "events": designs,
    }], ensure_ascii=False, indent=2) + "\n")
    print(f"wrote {len(catalog)} events")


if __name__ == "__main__":
    main()

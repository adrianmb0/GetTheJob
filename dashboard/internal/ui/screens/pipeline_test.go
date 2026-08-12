package screens

import (
	"strings"
	"testing"

	"github.com/adrianmb0/GetTheJob/dashboard/internal/model"
	"github.com/adrianmb0/GetTheJob/dashboard/internal/theme"
)

func TestWithReloadedDataPreservesStateAndSelection(t *testing.T) {
	initialApps := []model.CareerApplication{
		{
			Company:    "Acme",
			Role:       "Backend Engineer",
			Status:     "Evaluated",
			Score:      4.2,
			ReportPath: "reports/001-acme.md",
		},
		{
			Company:    "Beta",
			Role:       "Platform Engineer",
			Status:     "Applied",
			Score:      4.6,
			ReportPath: "reports/002-beta.md",
		},
	}

	pm := NewPipelineModel(
		theme.NewTheme("catppuccin-mocha"),
		initialApps,
		model.PipelineMetrics{Total: len(initialApps)},
		"..",
		120,
		40,
	)
	pm.sortMode = sortCompany
	pm.activeTab = 0
	pm.viewMode = "flat"
	pm.applyFilterAndSort()
	pm.cursor = 1
	pm.reportCache["reports/002-beta.md"] = reportSummary{tldr: "cached"}

	refreshedApps := []model.CareerApplication{
		initialApps[0],
		initialApps[1],
		{
			Company:    "Gamma",
			Role:       "AI Engineer",
			Status:     "Interview",
			Score:      4.8,
			ReportPath: "reports/003-gamma.md",
		},
	}

	reloaded := pm.WithReloadedData(refreshedApps, model.PipelineMetrics{Total: len(refreshedApps)})

	if reloaded.sortMode != sortCompany {
		t.Fatalf("expected sort mode %q, got %q", sortCompany, reloaded.sortMode)
	}
	if reloaded.viewMode != "flat" {
		t.Fatalf("expected view mode to stay flat, got %q", reloaded.viewMode)
	}
	if got := len(reloaded.filtered); got != 3 {
		t.Fatalf("expected 3 filtered apps after refresh, got %d", got)
	}
	if app, ok := reloaded.CurrentApp(); !ok || app.ReportPath != "reports/002-beta.md" {
		t.Fatalf("expected selection to stay on beta app, got %+v (ok=%v)", app, ok)
	}
	if reloaded.reportCache["reports/002-beta.md"].tldr != "cached" {
		t.Fatal("expected cached report summaries to survive refresh")
	}
}

func TestRenderAppLineIncludesDateColumn(t *testing.T) {
	pm := NewPipelineModel(
		theme.NewTheme("catppuccin-mocha"),
		nil,
		model.PipelineMetrics{},
		"..",
		120,
		40,
	)

	line := pm.renderAppLine(model.CareerApplication{
		Date:    "2026-04-13",
		Company: "Anthropic",
		Role:    "Forward Deployed Engineer",
		Status:  "Applied",
		Score:   4.5,
	}, false)

	if !strings.Contains(line, "2026-04-13") {
		t.Fatalf("expected rendered line to include date column, got %q", line)
	}
}

func TestDisplayGroupSplitsInterviewedRejections(t *testing.T) {
	cases := []struct {
		name  string
		app   model.CareerApplication
		group string
	}{
		{
			name:  "rejected after an interview",
			app:   model.CareerApplication{Status: "Rejected", Notes: "applied 2026-07-19 via dashboard; interview 2026-07-24 via dashboard; rejected 2026-08-05 via dashboard"},
			group: groupInterviewedRejected,
		},
		{
			name:  "rejected after moving to Interview",
			app:   model.CareerApplication{Status: "Rejected", Notes: "discovery call scheduled; moved to Interview 2026-06-05; rejected 2026-07-18 via dashboard"},
			group: groupInterviewedRejected,
		},
		{
			name:  "rejected without ever interviewing",
			app:   model.CareerApplication{Status: "Rejected", Notes: "applied 2026-07-19 via dashboard; rejected 2026-07-24 via dashboard"},
			group: "rejected",
		},
		{
			name:  "negated mention does not count",
			app:   model.CareerApplication{Status: "Rejected", Notes: "rejected at screen, no interview scheduled"},
			group: "rejected",
		},
		{
			name:  "still interviewing keeps its own status",
			app:   model.CareerApplication{Status: "Interview", Notes: "interview 2026-07-24 via dashboard"},
			group: "interview",
		},
		{
			name:  "interview mention on a non-rejected row is ignored",
			app:   model.CareerApplication{Status: "Applied", Notes: "applied 2026-08-01; interview loop described in the JD"},
			group: "applied",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := displayGroup(tc.app); got != tc.group {
				t.Fatalf("displayGroup = %q, want %q", got, tc.group)
			}
		})
	}
}

func TestInterviewedRejectedSortsAboveRejected(t *testing.T) {
	interviewed := model.CareerApplication{Status: "Rejected", Notes: "interview 2026-07-24 via dashboard; rejected 2026-08-05"}
	cold := model.CareerApplication{Status: "Rejected", Notes: "rejected 2026-07-24 via dashboard"}
	skipped := model.CareerApplication{Status: "SKIP", Notes: ""}

	if groupPriority(interviewed) >= groupPriority(cold) {
		t.Fatalf("interviewed rejection must sort above a cold one: %d vs %d", groupPriority(interviewed), groupPriority(cold))
	}
	if groupPriority(skipped) >= groupPriority(interviewed) {
		t.Fatalf("skip must stay above the rejected groups: %d vs %d", groupPriority(skipped), groupPriority(interviewed))
	}
}

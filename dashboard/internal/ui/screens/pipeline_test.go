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
			name:  "interviewed then rejected",
			app:   model.CareerApplication{Status: "Interviewed - Rejected"},
			group: groupInterviewedRejected,
		},
		{
			name:  "rejected without interviewing",
			app:   model.CareerApplication{Status: "Rejected"},
			group: "rejected",
		},
		{
			name:  "still interviewing stays active",
			app:   model.CareerApplication{Status: "Interview"},
			group: "interview",
		},
		{
			name:  "notes no longer decide the group",
			app:   model.CareerApplication{Status: "Rejected", Notes: "interview 2026-07-24 via dashboard; rejected 2026-08-05"},
			group: "rejected",
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
	interviewed := model.CareerApplication{Status: "Interviewed - Rejected"}
	cold := model.CareerApplication{Status: "Rejected"}
	skipped := model.CareerApplication{Status: "SKIP"}
	discarded := model.CareerApplication{Status: "Discarded"}

	if groupPriority(interviewed) >= groupPriority(cold) {
		t.Fatalf("interviewed rejection must sort above a cold one: %d vs %d", groupPriority(interviewed), groupPriority(cold))
	}
	if groupPriority(skipped) >= groupPriority(interviewed) {
		t.Fatalf("skip must stay above the rejected groups: %d vs %d", groupPriority(skipped), groupPriority(interviewed))
	}
	if groupPriority(cold) >= groupPriority(discarded) {
		t.Fatalf("discarded must stay below rejected: %d vs %d", groupPriority(cold), groupPriority(discarded))
	}
}

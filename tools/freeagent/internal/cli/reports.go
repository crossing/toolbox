package cli

import (
	"net/url"

	"github.com/spf13/cobra"
)

// Read-only accounting reports. These never mutate; op-mcp's read allowlist
// names each command explicitly.

func reportURL(path string, params url.Values) string {
	u := apiClient.BaseURL + path
	if encoded := params.Encode(); encoded != "" {
		u += "?" + encoded
	}
	return u
}

var balanceSheetAsAt string

var balanceSheetCmd = &cobra.Command{
	Use:   "balance-sheet",
	Short: "Show the balance sheet (assets, liabilities, owners' equity)",
	RunE: func(cmd *cobra.Command, args []string) error {
		params := url.Values{}
		if balanceSheetAsAt != "" {
			params.Set("as_at_date", balanceSheetAsAt)
		}
		report, err := apiClient.GetJSON(reportURL("/accounting/balance_sheet", params))
		if err != nil {
			return err
		}
		return formatOutput(report)
	},
}

var (
	plFromDate         string
	plToDate           string
	plAccountingPeriod string
)

var profitAndLossCmd = &cobra.Command{
	Use:   "profit-and-loss",
	Short: "Show the profit and loss summary",
	RunE: func(cmd *cobra.Command, args []string) error {
		params := url.Values{}
		if plFromDate != "" {
			params.Set("from_date", plFromDate)
		}
		if plToDate != "" {
			params.Set("to_date", plToDate)
		}
		if plAccountingPeriod != "" {
			params.Set("accounting_period", plAccountingPeriod)
		}
		report, err := apiClient.GetJSON(reportURL("/accounting/profit_and_loss/summary", params))
		if err != nil {
			return err
		}
		return formatOutput(report)
	},
}

var (
	tbFromDate string
	tbToDate   string
)

var trialBalanceCmd = &cobra.Command{
	Use:   "trial-balance",
	Short: "Show the trial balance summary (per-category totals)",
	RunE: func(cmd *cobra.Command, args []string) error {
		params := url.Values{}
		if tbFromDate != "" {
			params.Set("from_date", tbFromDate)
		}
		if tbToDate != "" {
			params.Set("to_date", tbToDate)
		}
		report, err := apiClient.GetJSON(reportURL("/accounting/trial_balance/summary", params))
		if err != nil {
			return err
		}
		return formatOutput(report)
	},
}

func init() {
	rootCmd.AddCommand(balanceSheetCmd)
	balanceSheetCmd.Flags().StringVar(&balanceSheetAsAt, "as-at", "", "Balance sheet as at this date (YYYY-MM-DD, default today)")

	rootCmd.AddCommand(profitAndLossCmd)
	profitAndLossCmd.Flags().StringVar(&plFromDate, "from", "", "Start date (YYYY-MM-DD)")
	profitAndLossCmd.Flags().StringVar(&plToDate, "to", "", "End date (YYYY-MM-DD)")
	profitAndLossCmd.Flags().StringVar(&plAccountingPeriod, "accounting-period", "", "Accounting year, e.g. 2025/26 (default: current period to date)")

	rootCmd.AddCommand(trialBalanceCmd)
	trialBalanceCmd.Flags().StringVar(&tbFromDate, "from", "", "Start date (YYYY-MM-DD)")
	trialBalanceCmd.Flags().StringVar(&tbToDate, "to", "", "End date (YYYY-MM-DD)")
}

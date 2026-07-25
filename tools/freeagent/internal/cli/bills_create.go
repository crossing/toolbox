package cli

import (
	"github.com/crossing/toolbox/tools/freeagent/internal/freeagent"

	"github.com/spf13/cobra"
)

var (
	contact     string
	reference   string
	datedOn     string
	dueOn       string
	category    string
	totalValue  string
	description string
)

// createCmd represents the create command
var createCmd = &cobra.Command{
	Use:   "create",
	Short: "Create a new bill",
	Long:  "Create a new bill in FreeAgent with the specified contact, reference, dates, and items.",
	RunE: func(cmd *cobra.Command, args []string) error {
		bill := freeagent.Bill{
			Contact:   contact,
			Reference: reference,
			DatedOn:   datedOn,
			DueOn:     dueOn,
			BillItems: []freeagent.BillItem{
				{
					Category:    category,
					TotalValue:  totalValue,
					Description: description,
				},
			},
		}

		newBill, err := apiClient.CreateBill(bill)
		if err != nil {
			return err
		}

		return formatOutput(newBill)
	},
}

func init() {
	billsCmd.AddCommand(createCmd)

	createCmd.Flags().StringVar(&contact, "contact", "", "Contact URI")
	createCmd.Flags().StringVar(&reference, "reference", "", "Bill reference")
	createCmd.Flags().StringVar(&datedOn, "date", "", "Bill date (YYYY-MM-DD)")
	createCmd.Flags().StringVar(&dueOn, "due", "", "Due date (YYYY-MM-DD)")
	createCmd.Flags().StringVar(&category, "category", "", "Category URI")
	createCmd.Flags().StringVar(&totalValue, "value", "", "Total value")
	createCmd.Flags().StringVar(&description, "description", "", "Item description")

	_ = createCmd.MarkFlagRequired("contact")
	_ = createCmd.MarkFlagRequired("reference")
	_ = createCmd.MarkFlagRequired("date")
	_ = createCmd.MarkFlagRequired("due")
	_ = createCmd.MarkFlagRequired("category")
	_ = createCmd.MarkFlagRequired("value")
}
